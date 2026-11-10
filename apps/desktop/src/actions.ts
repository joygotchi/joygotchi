import { invoke } from '@tauri-apps/api/core';
import { ACTION_PRICE, formatCredits, type StakeAccount } from '@joygotchi/pet';

/** One line into the app's output, where a terminal can read it. */
const trace = (message: string) => void invoke('log_line', { message }).catch(() => {});
import { reactToGame, signAndSend } from './wallet.svelte';

/**
 * A contract saying no while the transaction says yes.
 *
 * `feed_pet` spends credits, calls the game contract, and refunds itself from
 * a callback when the game refuses. That refund is the correct behaviour and
 * it is also a successful transaction — nothing throws, no receipt fails, and
 * `await` returns normally. So a refusal has to be read out of the logs, or
 * the app reports a feed that never happened.
 *
 * This was exactly that bug: feeding a starved pet said "Fed." and changed
 * nothing, which is the worst possible answer. The pet needs a revival item,
 * and now it says so.
 */
export class RefundedError extends Error {}

/**
 * The reason inside a `*_refunded` transaction, if there is one.
 *
 * The game contract writes its own sentence with `log_str` before returning
 * false — "This pet has starved", "That pet belongs to someone else" — and
 * that sentence is better than anything this layer could invent, so it is
 * preferred over a generic message when present.
 *
 * The event name is parsed rather than searched for. `auto_feed_refunded`
 * contains `feed_refunded`, so a substring match reports the oracle's refusal
 * as the player's own — a test caught that, which is the entire reason this
 * reads the name instead.
 */
function refusalIn(logs: string[], marker: string): string | null {
  const refunded = logs.some((line) => {
    if (!line.startsWith('EVENT_JSON:')) return false;
    try {
      return (JSON.parse(line.slice('EVENT_JSON:'.length)) as { event?: string }).event === marker;
    } catch {
      return false;
    }
  });
  if (!refunded) return null;

  const spoken = logs.find(
    (line) => !line.startsWith('EVENT_JSON:') && /starved|belongs to|No such pet/i.test(line)
  );
  return spoken ?? 'The contract refused it and your credits were refunded.';
}

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
): Promise<string> {
  if (!canSpend(account, ACTION_PRICE.feed)) {
    throw new Error(`Feeding costs ${ACTION_PRICE.feed} credits, and there are not enough.`);
  }
  await claimIfShort(network, account, ACTION_PRICE.feed);

  const { hash, logs } = await signAndSend(network, 'feed_pet', { pet_id: petId });

  const refused = refusalIn(logs, 'feed_refunded');
  if (refused) throw new RefundedError(refused);

  reactToGame('fed');

  // Returned so the caller can have the XP paid for this exact meal. The
  // hash is the meal's identity on chain, and the contract pays each one
  // once.
  return hash;
}

/**
 * Whether an action can go through at all — balance and claimable together,
 * because the claim happens on the way.
 */
export function canSpend(account: StakeAccount | null, price: number): boolean {
  if (!account) return false;
  const balance = Number(formatCredits(account.credit_balance, 6));
  const pending = Number(formatCredits(account.pending_credits, 6));
  return balance + pending >= price;
}

/** Whether a feed can go through. The common case, kept for the callers. */
export const canAfford = (account: StakeAccount | null) =>
  canSpend(account, ACTION_PRICE.feed);

/**
 * Claim first when the balance alone will not cover the price.
 *
 * Earned credits sit in `pending` until `claim_credits` moves them, and the
 * contract only ever spends the balance — so "not enough credits" while the
 * window shows plenty is a thing that happens unless this runs first. Shared
 * because feeding and reviving both need it, and two copies of this rule
 * would be one copy away from an action that fails for a reason nobody can
 * see.
 */
async function claimIfShort(
  network: string,
  account: StakeAccount | null,
  price: number
): Promise<void> {
  const balance = Number(account ? formatCredits(account.credit_balance, 6) : 0);
  const pending = Number(account ? formatCredits(account.pending_credits, 6) : 0);
  if (balance < price && pending > 0) {
    await signAndSend(network, 'claim_credits', {});
  }
}

/** Where the local feed oracle listens. Loopback, because it holds a key. */
export const ORACLE_URL = 'http://127.0.0.1:8787';

/**
 * Ask the local oracle to pay a feed's XP.
 *
 * Separate from the feed, and in this order on purpose. `feed_pet` is the
 * part that costs credits and the part the chain records; the XP is awarded
 * afterwards by a process reading that record. If the oracle is not running
 * the meal still happened, the pet still ate and still rolled for a drop,
 * and the XP is the only thing missing — a far better failure than a meal
 * that did not happen because a local service was down.
 *
 * It goes to the oracle rather than the web app because paying means calling
 * `award_feed_xp`, and that key stays on this machine.
 */
export async function gradeFeed(
  hash: string,
  accountId: string,
  oracle: string = ORACLE_URL
): Promise<{ xp: number | null; line?: string | null; why?: string }> {
  trace(`grade: asking ${oracle} about ${hash}`);
  try {
    const response = await fetch(`${oracle}/grade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: hash, accountId })
    });
    const body = (await response.json()) as { xp?: number; line?: string; error?: string };
    trace(`grade: ${response.status} ${JSON.stringify(body)}`);
    return {
      xp: typeof body.xp === 'number' ? body.xp : null,
      line: body.line ?? null,
      why: body.error
    };
  } catch (cause) {
    trace(`grade: fetch failed — ${cause instanceof Error ? cause.message : String(cause)}`);
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

/**
 * Move a pet to its next phase, paid in credits.
 *
 * The price has been in the contract since the sinks were seeded and nothing
 * ever spent it on anything — `evolve` on the game contract takes no payment
 * and no call joined the two, so half a credit went nowhere. `evolve_pet`
 * charges and calls through, and refunds when the game says no.
 */
export async function evolvePet(
  network: string,
  petId: number,
  account: StakeAccount | null
): Promise<void> {
  if (!canSpend(account, ACTION_PRICE.evolve)) {
    throw new Error(
      `Evolving costs ${ACTION_PRICE.evolve} credits, and there are not enough.`
    );
  }
  await claimIfShort(network, account, ACTION_PRICE.evolve);

  const { logs } = await signAndSend(network, 'evolve_pet', { pet_id: petId });

  const refused = refusalIn(logs, 'evolve_refunded');
  if (refused) throw new RefundedError(refused);

  reactToGame('fed');
}

/**
 * Bring a starved pet back, paid in credits.
 *
 * Holy Water does the same for NEAR through the game contract's shop, which
 * is payable — so no session key can ever reach it, and losing a pet meant a
 * browser round trip and a token nobody earns by playing. This signs here.
 */
export async function revivePet(
  network: string,
  petId: number,
  account: StakeAccount | null
): Promise<void> {
  if (!canSpend(account, ACTION_PRICE.revive)) {
    throw new Error(
      `Reviving costs ${ACTION_PRICE.revive} credits, and there are not enough.`
    );
  }
  await claimIfShort(network, account, ACTION_PRICE.revive);

  const { logs } = await signAndSend(network, 'revive_pet', { pet_id: petId });

  const refused = refusalIn(logs, 'revive_refunded');
  if (refused) throw new RefundedError(refused);

  reactToGame('fed');
}
