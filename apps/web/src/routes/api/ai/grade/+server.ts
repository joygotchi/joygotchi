import { json } from '@sveltejs/kit';
import { GAME_CONTRACT } from '#lib/config';
import { AiUnavailableError, complete, mealGrader } from '#lib/server/near-ai';
import { corsHeaders, preflight } from '#lib/server/cors';
import { viewFunction } from '#lib/near/rpc';
import { MAX_FEED_XP, MIN_FEED_XP, mealFrom, type ChainPet, type TxStatus } from '@joygotchi/pet';
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
 * Measured, 24 samples per cell, because a grader is the kind of thing that
 * looks fine and returns a constant:
 *
 *   prompt            | well fed          | starved        | gap
 *   pet graded itself | 36 x24            | 36 x24         | 1.00x
 *   neutral, no bands | 5-6,  mean 6.0    | 31-34, m 31.8  | 5.33x
 *   one "ordinary"    | 18-22, mean 19.6  | 34 x24         | 1.74x
 *   three bands       | 14 x24            | 31-32, m 31.3  | 2.24x
 *
 * Row one is why `mealGrader` exists. Row two is why it has bands: a
 * fivefold gap pays players for letting a pet starve. Row four is current,
 * and the gap is where it should be.
 *
 * The column that matters more is the spread. Across all four prompts and
 * 168 samples the model never varied meaningfully inside a band — it picks
 * one number per hunger state and stays there, 14 and 31 here, whatever
 * "pick a different number inside that band" asks of it. `MIN_FEED_XP` has
 * never once fired either; the bands decide everything.
 *
 * Which means the grade is a deterministic function of `starves_at`, and a
 * model is an expensive way to evaluate one. The numbers could come off the
 * chain for nothing: no key, no network, no latency, and a player could
 * check the arithmetic. If the model stays in this path it should be for the
 * pet's reaction line, which is the part a formula genuinely cannot write.
 *
 * Worth re-measuring after any change to the prompt: nothing else here will
 * fail if the grade stops meaning anything.
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
        { role: 'system', content: mealGrader(pet) },
        { role: 'user', content: 'Grade this meal.' }
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
  return Number.isFinite(base)
    ? Math.min(Math.max(base, MIN_FEED_XP), MAX_FEED_XP / 2)
    : MIN_FEED_XP;
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
