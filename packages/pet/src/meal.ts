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
 * Turn a model's answer into XP.
 *
 * The model writes a number in a sentence and sometimes a sentence with no
 * number. Anything unreadable scores the floor rather than nothing: the meal
 * was bought and paid for, and a model having an off day is not the player's
 * fault.
 *
 * A Focus Lens doubles it, which is what the item promises, and the clamp is
 * the contract's own cap applied before the call rather than after — a
 * request for 500 would be silently cut to 72 on chain, and a number the
 * caller never sees is a number nobody can check.
 */
export function xpFrom(answer: string, lensApplied: boolean): number {
  const found = answer.match(/\d+/);
  const base = found ? Number(found[0]) : 0;
  const scored = Number.isFinite(base) ? Math.min(Math.max(base, 1), MAX_FEED_XP / 2) : 1;
  return Math.min(lensApplied ? scored * 2 : scored, MAX_FEED_XP);
}
