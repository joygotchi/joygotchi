import { json } from '@sveltejs/kit';
import { GAME_CONTRACT } from '#lib/config';
import { AiUnavailableError, complete, petPersona } from '#lib/server/near-ai';
import { corsHeaders, preflight } from '#lib/server/cors';
import { viewFunction } from '#lib/near/rpc';
import { MAX_FEED_XP, mealFrom, type ChainPet, type TxStatus } from '@joygotchi/pet';
import { RPC_URL } from '#lib/config';
import type { RequestHandler } from './$types';

/**
 * What a meal was worth, as an opinion. Nothing here signs.
 *
 * `spend_credits("ai_feed")` charges for a meal and records it, and that is
 * all a contract can do: deciding whether the food was any good takes a
 * model, and a contract cannot run one. So this reads the purchase back off
 * the chain, asks NEAR AI what it was worth, and returns a number.
 *
 * Paying that number out is somebody else's job, deliberately. This service
 * runs on a host we rent, and `award_feed_xp` is gated to one account — so
 * putting the signing key here would mean leaving a key that writes to the
 * contract on a third party's machine, to save the local oracle an RPC call
 * it has to make anyway. The oracle already holds a key and already runs. It
 * verifies the transaction itself and signs; this only has the model.
 *
 * Which is why the verification below is here too, duplicated on purpose. It
 * is not protecting the XP — the oracle's copy does that. It is protecting
 * the model tokens, because without it a bare hash buys a NEAR AI call for
 * free.
 *
 * The number is the grade and nothing else: a Focus Lens doubles it, and
 * that doubling belongs to whoever read the receipt that burned the lens. If
 * both sides applied it, a lens meal would pay four times.
 */
const STAKE_CONTRACT = GAME_CONTRACT.replace(/^jg-game-/, 'jg-stake-');

export const OPTIONS: RequestHandler = ({ request }) => preflight(request);

export const POST: RequestHandler = async ({ request }) => {
  const cors = corsHeaders(request.headers.get('origin'));

  const body = (await request.json().catch(() => null)) as {
    txHash?: string;
    accountId?: string;
  } | null;

  const txHash = (body?.txHash ?? '').trim();
  const accountId = (body?.accountId ?? '').trim();

  if (!txHash || txHash.length > 64) {
    return json({ error: 'txHash is required' }, { status: 400, headers: cors });
  }
  if (!accountId) {
    return json({ error: 'accountId is required' }, { status: 400, headers: cors });
  }

  const status = await txStatus(txHash, accountId).catch(() => null);
  if (!status) {
    return json({ error: 'could not read that transaction' }, { status: 404, headers: cors });
  }

  const found = mealFrom(status, { stakeContract: STAKE_CONTRACT, accountId });
  if (!found.ok) return json({ error: found.why }, { status: 400, headers: cors });

  const pet = await viewFunction<ChainPet | null>(GAME_CONTRACT, 'get_pet', {
    pet_id: found.meal.petId
  }).catch(() => null);
  if (!pet) {
    return json({ error: `no pet ${found.meal.petId}` }, { status: 404, headers: cors });
  }

  try {
    const answer = await complete(
      [
        { role: 'system', content: petPersona(pet, { viewerIsOwner: true }) },
        {
          role: 'user',
          content:
            'Your owner just bought you a meal. How good was it? ' +
            `Answer with a single whole number from 1 to ${MAX_FEED_XP / 2} and nothing else.`
        }
      ],
      { maxTokens: 20, temperature: 0.8 }
    );
    return json({ petId: found.meal.petId, grade: gradeFrom(answer) }, { headers: cors });
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      return json({ error: error.message }, { status: 503, headers: cors });
    }
    // The meal was bought. A model that will not answer is this service's
    // problem, not the player's, so it scores the floor rather than nothing.
    return json({ petId: found.meal.petId, grade: gradeFrom('') }, { headers: cors });
  }
};

/**
 * The model writes a number in a sentence, and sometimes a sentence with no
 * number. Unreadable scores the floor rather than nothing.
 */
function gradeFrom(answer: string): number {
  const found = answer.match(/\d+/);
  const base = found ? Number(found[0]) : 0;
  return Number.isFinite(base) ? Math.min(Math.max(base, 1), MAX_FEED_XP / 2) : 1;
}

/** The transaction, with every receipt it produced. */
async function txStatus(txHash: string, accountId: string): Promise<TxStatus> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'grade',
      method: 'tx',
      params: { tx_hash: txHash, sender_account_id: accountId, wait_until: 'EXECUTED' }
    })
  });
  const body = (await response.json()) as { result?: TxStatus };
  if (!body.result) throw new Error('no such transaction');
  return body.result;
}
