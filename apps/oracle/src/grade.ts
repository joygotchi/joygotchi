/**
 * Paying out a meal's XP, from the machine that holds the key.
 *
 * The contract cannot grade food — that takes a model. The web service has
 * the model but must not have this key: it runs on a rented host, and
 * `award_feed_xp` writes to the contract. So the work splits where the
 * secrets already are. The web service returns a number. This verifies the
 * purchase against the chain itself and signs.
 *
 * It asks the web service for the number and then checks the chain anyway,
 * rather than taking the pet and the XP from the reply. The reply arrives
 * over a network from a host we do not own; what it is trusted for is the
 * opinion, which is all it was asked for. Which pet, whose account and
 * whether a lens burned come from the receipts.
 */
import { mealFrom, xpFrom, MAX_FEED_XP, type TxStatus } from '@joygotchi/pet';

export type Grader = {
  /** A view call on a contract. */
  view: <T>(contractId: string, method: string, args?: Record<string, unknown>) => Promise<T>;
  /** The transaction with its receipts, straight from an RPC node. */
  txStatus: (txHash: string, accountId: string) => Promise<TxStatus>;
  /**
   * Ask the web service what the meal was worth: a grade from 1 to
   * MAX_FEED_XP / 2, before any lens.
   */
  opinion: (txHash: string, accountId: string) => Promise<string>;
  /** Sign `award_feed_xp`. Absent in a dry run. */
  award: ((petId: number, xp: number, meal: string) => Promise<string | undefined>) | null;
  stake: string;
};

export type Graded =
  | { ok: true; petId: number; xp: number; lens: boolean; tx?: string }
  | { ok: false; status: number; why: string };

/**
 * Grade one meal and pay it.
 *
 * The order matters. `meal_was_graded` first because the contract refuses a
 * repeat and that refusal costs a transaction; the chain reads next, because
 * everything the payment depends on comes from them; the model last, because
 * it is the only step that costs money to ask.
 */
export async function gradeMeal(
  txHash: string,
  accountId: string,
  deps: Grader
): Promise<Graded> {
  if (!txHash || txHash.length > 64) {
    return { ok: false, status: 400, why: 'txHash is required' };
  }
  if (!accountId) {
    return { ok: false, status: 400, why: 'accountId is required' };
  }

  const already = await deps
    .view<boolean>(deps.stake, 'meal_was_graded', { meal: txHash })
    .catch(() => false);
  if (already) {
    return { ok: false, status: 409, why: 'that meal has already earned its XP' };
  }

  const status = await deps.txStatus(txHash, accountId).catch(() => null);
  if (!status) {
    return { ok: false, status: 404, why: 'could not read that transaction' };
  }

  const found = mealFrom(status, { stakeContract: deps.stake, accountId });
  if (!found.ok) return { ok: false, status: 400, why: found.why };

  /*
   * A model that will not answer scores the floor, not nothing: the meal was
   * bought and paid for, and a grader having an off day is not the player's
   * problem. `xpFrom('')` is that floor.
   */
  const answer = await deps.opinion(txHash, accountId).catch(() => '');
  const xp = xpFrom(answer, found.meal.lensApplied);

  if (!deps.award) {
    return { ok: true, petId: found.meal.petId, xp, lens: found.meal.lensApplied };
  }

  try {
    const tx = await deps.award(found.meal.petId, xp, txHash);
    return { ok: true, petId: found.meal.petId, xp, lens: found.meal.lensApplied, tx };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    /*
     * This one is worth naming. A function-call key is bound to a list of
     * methods at the moment it is granted and can never be widened, so a key
     * that only covers `auto_feed` fails here every time and looks like a
     * network problem. It is a key that needs regranting, and the message
     * should say which.
     */
    return {
      ok: false,
      status: 502,
      why: /does not allow method/.test(why)
        ? `${why} — this process holds a key for \`auto_feed\` only. Regrant it for both ` +
          'methods; see the README.'
        : why
    };
  }
}

/**
 * The grade out of the web service's reply, as text for `xpFrom`.
 *
 * Deliberately only the grade. The lens multiplier is applied here, by
 * `xpFrom`, against the receipt this process read — never against a flag in
 * the reply. A service that is wrong, or lying, about a lens then cannot
 * double anything; the worst it can do is pick a number inside the range it
 * was asked for.
 */
export function gradeIn(body: unknown): string {
  const grade = (body as { grade?: unknown })?.grade;
  return typeof grade === 'number' && Number.isFinite(grade)
    ? String(Math.min(Math.max(Math.round(grade), 1), MAX_FEED_XP / 2))
    : '';
}
