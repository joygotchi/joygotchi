import {
  ACTION_PRICE,
  formatCredits,
  toMicroCredits,
  type StakeAccount
} from '@joygotchi/pet';
import { reactToGame, signAndSend } from './wallet.svelte';

/**
 * Feed a pet, claiming first when the balance alone will not cover it.
 *
 * `feed_pet` on the staking contract, not `spend_credits("ai_feed")`: the
 * latter charges and records a meal that nothing ever turns into food. This
 * one spends credits and calls through to the game contract, which moves
 * the starvation clock and refunds if it refuses.
 *
 * Shared, because there are two ways to feed now — the panel's tile and the
 * button on the name plate — and feeding is not one call. Earned credits sit
 * in `pending` until `claim_credits` moves them, and the contract only ever
 * spends the balance, so "not enough credits" while the window shows plenty
 * is a thing that happens unless this runs first. Two copies of that rule
 * would be one copy away from a quick-feed that fails for a reason nobody
 * can see.
 */
export async function feedPet(
  network: string,
  petId: number,
  account: StakeAccount | null
): Promise<void> {
  if (!canAfford(account)) {
    throw new Error(`Feeding costs ${ACTION_PRICE.feed} credits, and there are not enough.`);
  }

  const balance = Number(account ? formatCredits(account.credit_balance, 6) : 0);
  const pending = Number(account ? formatCredits(account.pending_credits, 6) : 0);

  if (balance < ACTION_PRICE.feed && pending > 0) {
    await signAndSend(network, 'claim_credits', {});
  }

  await signAndSend(network, 'feed_pet', { pet_id: petId });

  reactToGame('fed');
}

/**
 * Whether a feed can go through at all — balance and claimable together,
 * because the claim happens on the way.
 */
export function canAfford(account: StakeAccount | null): boolean {
  if (!account) return false;
  const balance = Number(formatCredits(account.credit_balance, 6));
  const pending = Number(formatCredits(account.pending_credits, 6));
  return balance + pending >= ACTION_PRICE.feed;
}

/** Where the local feed oracle listens. Loopback, because it holds a key. */
export const ORACLE_URL = 'http://127.0.0.1:8787';

/**
 * Buy an AI meal and have it graded.
 *
 * Two steps on purpose, and in this order. `spend_credits` is the part that
 * costs something and the part the chain records; grading is a favour done
 * afterwards by a service that reads that record. If the grader is down the
 * meal still happened, the pet still earns its drop roll, and the XP is the
 * only thing missing — which is a far better failure than a meal that did
 * not happen because a server was unreachable.
 *
 * The grade is asked of the local oracle rather than the web app, because
 * paying the XP means calling `award_feed_xp`, and that key stays on this
 * machine. The oracle verifies this transaction itself and asks the web app
 * only for the number.
 */
export async function aiMeal(
  network: string,
  petId: number,
  account: StakeAccount | null,
  accountId: string,
  oracle: string = ORACLE_URL
): Promise<{ xp: number | null; why?: string }> {
  const balance = Number(account ? formatCredits(account.credit_balance, 6) : 0);
  const pending = Number(account ? formatCredits(account.pending_credits, 6) : 0);
  if (balance + pending < ACTION_PRICE.ai_feed) {
    throw new Error(`An AI meal costs ${ACTION_PRICE.ai_feed} credits, and there are not enough.`);
  }
  if (balance < ACTION_PRICE.ai_feed && pending > 0) {
    await signAndSend(network, 'claim_credits', {});
  }

  const { hash } = await signAndSend(network, 'spend_credits', {
    action: 'ai_feed',
    pet_id: petId,
    amount: toMicroCredits(ACTION_PRICE.ai_feed)
  });

  reactToGame('fed');

  try {
    const response = await fetch(`${oracle}/grade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: hash, accountId })
    });
    const body = (await response.json()) as { xp?: number; error?: string };
    return { xp: typeof body.xp === 'number' ? body.xp : null, why: body.error };
  } catch {
    /*
     * Unreachable means the oracle is not running on this machine. Saying
     * "fetch failed" would send someone looking at their network; the meal
     * itself went through, so this names the one thing that did not.
     */
    return {
      xp: null,
      why: 'The meal was bought, but the local feeder is not running, so it earned no XP yet.'
    };
  }
}
