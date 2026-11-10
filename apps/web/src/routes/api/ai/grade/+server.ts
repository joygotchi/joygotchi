import { json } from '@sveltejs/kit';
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from 'near-api-js';
import { ORACLE_ACCOUNT, ORACLE_KEY } from '$app/env/private';
import { GAME_CONTRACT, RPC_URL } from '#lib/config';
import { AiUnavailableError, complete, petPersona } from '#lib/server/near-ai';
import { corsHeaders, preflight } from '#lib/server/cors';
import { MAX_FEED_XP, mealFrom, xpFrom, type TxStatus } from '#lib/server/meal';
import { viewFunction } from '#lib/near/rpc';
import type { ChainPet } from '@joygotchi/pet';
import type { RequestHandler } from './$types';

/**
 * Grade a meal and pay its XP.
 *
 * `spend_credits("ai_feed")` charges for a meal and records it, and that is
 * all a contract can do: deciding whether the food was any good takes a
 * model, and a contract cannot run one. So the chain records the purchase,
 * this reads it back, asks NEAR AI what it was worth, and calls
 * `award_feed_xp` with a key that can do nothing else.
 *
 * The client sends a transaction hash, which is a pointer and not a claim.
 * Everything that decides the XP is read from that transaction's receipts:
 * whose account, which pet, whether a Focus Lens was burned. Lying takes
 * producing a transaction, and producing one costs the credits it is asking
 * to be paid for.
 *
 * Paying twice is the other half, and the contract holds that line:
 * `award_feed_xp` records the meal and refuses a repeat. This checks first
 * only to fail cheaply.
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
  if (!ORACLE_KEY || !ORACLE_ACCOUNT) {
    return json({ error: 'no oracle key is configured' }, { status: 503, headers: cors });
  }

  // Cheap refusal. The contract would refuse this too, and that refusal
  // costs a transaction.
  const already = await viewFunction<boolean>(STAKE_CONTRACT, 'meal_was_graded', {
    meal: txHash
  }).catch(() => false);
  if (already) {
    return json({ error: 'that meal has already earned its XP' }, { status: 409, headers: cors });
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

  let xp: number;
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
    xp = xpFrom(answer, found.meal.lensApplied);
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      return json({ error: error.message }, { status: 503, headers: cors });
    }
    // The meal was bought. A model that will not answer is this service's
    // problem, not the player's, so it scores the floor rather than nothing.
    xp = xpFrom('', found.meal.lensApplied);
  }

  try {
    const signer = KeyPairSigner.fromSecretKey(ORACLE_KEY as KeyPairString);
    const oracle = new Account(
      ORACLE_ACCOUNT,
      new JsonRpcProvider({ url: RPC_URL }),
      signer
    );
    const outcome = await oracle.callFunctionRaw({
      contractId: STAKE_CONTRACT,
      methodName: 'award_feed_xp',
      args: { pet_id: found.meal.petId, xp, meal: txHash },
      gas: 100_000_000_000_000n,
      deposit: 0n
    });

    return json(
      { petId: found.meal.petId, xp, lens: found.meal.lensApplied, tx: outcome.transaction?.hash },
      { headers: cors }
    );
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502, headers: cors }
    );
  }
};

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
  const body = (await response.json()) as { result?: TxStatus; error?: unknown };
  if (!body.result) throw new Error('no such transaction');
  return body.result;
}
