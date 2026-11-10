/**
 * Reading a meal out of the transaction that bought it.
 *
 * The app hands this service a transaction hash and asks for XP. A hash is
 * not a claim to be trusted — it is a pointer at the chain, and the chain is
 * what gets read. Everything the grade depends on comes from the receipts:
 * which pet, whose account, whether a Focus Lens was burned.
 *
 * Shared, and read by two processes for two different reasons. The oracle
 * reads it because it holds the key: whoever signs has to be the one who
 * checked, or a verdict arriving over the network is just a claim again. The
 * web service reads it because grading costs model tokens, and an unverified
 * hash would buy those tokens for free.
 */

export type Meal = {
  petId: number;
  accountId: string;
  /** A Focus Lens was consumed, which the contract records and we honour. */
  lensApplied: boolean;
  /** Micro-credits actually charged, as the contract decided — not as asked. */
  amount: number;
};

type Receipt = { outcome?: { logs?: string[]; executor_id?: string } };

export type TxStatus = {
  transaction?: { signer_id?: string; receiver_id?: string };
  receipts_outcome?: Receipt[];
};

const EVENT = 'EVENT_JSON:';

/**
 * The meal a transaction bought, or why it bought none.
 *
 * `expect` is the staking contract this deployment uses. A transaction on
 * somebody else's contract can carry a perfectly well-formed `credit_spent`
 * event, and paying XP for it would mean anyone could mint XP by deploying
 * their own copy.
 */
export function mealFrom(
  tx: TxStatus,
  expect: { stakeContract: string; accountId: string }
): { ok: true; meal: Meal } | { ok: false; why: string } {
  if (tx.transaction?.receiver_id !== expect.stakeContract) {
    return { ok: false, why: 'that transaction was not sent to this lab contract' };
  }
  if (tx.transaction?.signer_id !== expect.accountId) {
    return { ok: false, why: 'that transaction was signed by somebody else' };
  }

  for (const receipt of tx.receipts_outcome ?? []) {
    // Only logs the staking contract itself wrote. A cross-contract call in
    // the same transaction can log anything it likes.
    if (receipt.outcome?.executor_id !== expect.stakeContract) continue;

    for (const line of receipt.outcome?.logs ?? []) {
      if (!line.startsWith(EVENT)) continue;
      let event: {
        standard?: string;
        event?: string;
        data?: Array<Record<string, unknown>>;
      };
      try {
        event = JSON.parse(line.slice(EVENT.length));
      } catch {
        continue;
      }
      if (event.standard !== 'joygotchi' || event.event !== 'credit_spent') continue;

      const data = event.data?.[0];
      if (!data || data.action !== 'ai_feed') continue;
      if (data.account_id !== expect.accountId) continue;

      const petId = Number(data.pet_id);
      if (!Number.isInteger(petId) || petId < 1) {
        return { ok: false, why: 'that meal names no pet' };
      }

      return {
        ok: true,
        meal: {
          petId,
          accountId: expect.accountId,
          lensApplied: data.lens_applied === true,
          amount: Number(data.amount ?? 0)
        }
      };
    }
  }

  return { ok: false, why: 'no AI meal in that transaction' };
}

/** The contract's own ceiling, mirrored so a grade is clamped before it is sent. */
export const MAX_FEED_XP = 72;

/**
 * What a meal is worth at its very worst, before a lens.
 *
 * A third of the pre-lens ceiling, and the number exists because of what the
 * grader measured: a starved pet scored ~32 and a well-fed one ~6, so buying
 * a meal for a healthy pet earned a fifth of what neglecting it first would.
 * Food being worth more to a hungry animal is correct; paying five times for
 * letting it get that way is a reward for neglect.
 *
 * Twelve narrows that to under three times. It also sets the floor for a
 * grader that will not answer at all, which was paying 1 — a rounding error
 * on a meal the player was charged for.
 */
export const MIN_FEED_XP = 12;

/**
 * What a meal is worth, by how hungry the pet was when it ate.
 *
 * This replaced a model, and the reason is measurement rather than taste.
 * Across four prompts and 168 samples the grader never varied meaningfully
 * inside a band: it picked one number per hunger state and stayed on it, so
 * the "grade" was already a function of `starves_at` — evaluated over a
 * network, with a key, at a model's latency, and unverifiable by the player
 * who was paying for it.
 *
 * The same three numbers come out of arithmetic. The difference is that this
 * costs nothing, cannot be unavailable, and anyone holding the meal hash can
 * recompute it and check they were paid correctly.
 */
export const FEED_BANDS = [
  /*
   * Ordered hungriest first, and matched on the first threshold that holds.
   * The hours mirror `hungerOf` on the web app, which is what a pet says
   * about itself — a pet describing itself as famished while the payout
   * called it well fed would be the app disagreeing with itself in front of
   * the player.
   */
  // One hour covers both famished and already starved: a starved pet has
  // zero seconds left, which is under an hour.
  { hours: 1, low: 26, high: MAX_FEED_XP / 2 },
  { hours: 6, low: 18, high: 24 },
  { hours: Infinity, low: MIN_FEED_XP, high: 16 }
] as const;

/**
 * A stable position inside a band, from the hash of the meal that bought it.
 *
 * Deterministic variety, which is a different thing from randomness: two
 * people with the same meal hash get the same number, and nobody can roll
 * again by asking twice. A flat payout per state would work, but every meal
 * scoring exactly 14 reads like a stub, and the spread costs nothing here.
 */
function positionIn(meal: string, width: number): number {
  if (width <= 0) return 0;
  let sum = 0;
  for (let index = 0; index < meal.length; index++) {
    // Mixed with the position so an anagram of a hash is not the same roll.
    sum = (sum + meal.charCodeAt(index) * (index + 1)) % 1_000_003;
  }
  return sum % width;
}

/**
 * The XP a meal earns.
 *
 * `secondsUntilStarving` is read off the chain by whoever is about to sign,
 * not sent by the client: it is the one input that decides the payout, and a
 * caller who could set it could pay itself the ceiling every time.
 *
 * A Focus Lens doubles it, which is what the item promises, and the result is
 * clamped to the contract's own cap before the call rather than after — a
 * request for 500 would be silently cut to 72 on chain, and a number the
 * caller never sees is a number nobody can check.
 */
export function feedXp(input: {
  secondsUntilStarving: number;
  meal: string;
  lensApplied: boolean;
}): number {
  const hoursLeft = Math.max(0, input.secondsUntilStarving) / 3_600;
  // The last band is open-ended, so this always matches; the fallback is for
  // the type, and for a caller that hands over a non-finite number.
  const band = FEED_BANDS.find((candidate) => hoursLeft < candidate.hours) ?? FEED_BANDS[0]!;

  const scored = band.low + positionIn(input.meal, band.high - band.low + 1);
  const bounded = Math.min(Math.max(scored, MIN_FEED_XP), MAX_FEED_XP / 2);
  return Math.min(input.lensApplied ? bounded * 2 : bounded, MAX_FEED_XP);
}
