/**
 * Paying out a meal's XP, from the machine that holds the key.
 *
 * Everything the payment depends on is read here, from the chain, by the
 * process that signs. The pet, the account and whether a lens burned come
 * out of the transaction's receipts; how hungry the pet was comes from the
 * game contract; the XP is arithmetic over those.
 *
 * A model used to decide the number, and `feedXp` carries the measurement
 * that retired it. What is left for the web service is the pet's line, which
 * is flavour: it is fetched after the signature and a failure costs nothing
 * but silence.
 */
import { feedXp, mealFrom, type TxStatus } from '@joygotchi/pet';

export type Grader = {
  /** A view call on a contract. */
  view: <T>(contractId: string, method: string, args?: Record<string, unknown>) => Promise<T>;
  /** The transaction with its receipts, straight from an RPC node. */
  txStatus: (txHash: string, accountId: string) => Promise<TxStatus>;
  /** Something for the pet to say. Flavour only; it never gates the XP. */
  line?: (petId: number) => Promise<string | null>;
  /** Sign `award_feed_xp`. Absent in a dry run. */
  award: ((petId: number, xp: number, meal: string) => Promise<string | undefined>) | null;
  stake: string;
  game: string;
};

export type Graded =
  | { ok: true; petId: number; xp: number; lens: boolean; tx?: string; line?: string | null }
  | { ok: false; status: number; why: string };

/**
 * Grade one meal and pay it.
 *
 * The order matters. `meal_was_graded` first because the contract refuses a
 * repeat and that refusal costs a transaction; the receipts next, because
 * they say whether there is anything to pay for at all; the pet's hunger
 * last of the three, because it is the only read that decides the amount.
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
   * Hunger is read here rather than taken from the caller. It is the one
   * input that decides the payout, so a caller able to set it could pay
   * itself the ceiling on every meal.
   */
  const pet = await deps
    .view<{ seconds_until_starving?: string | number } | null>(deps.game, 'get_pet', {
      pet_id: found.meal.petId
    })
    .catch(() => null);
  if (!pet) {
    return { ok: false, status: 404, why: `no pet ${found.meal.petId}` };
  }

  const xp = feedXp({
    secondsUntilStarving: Number(pet.seconds_until_starving ?? 0),
    meal: txHash,
    lensApplied: found.meal.lensApplied
  });

  if (!deps.award) {
    return { ok: true, petId: found.meal.petId, xp, lens: found.meal.lensApplied };
  }

  try {
    const tx = await deps.award(found.meal.petId, xp, txHash);
    // After the signature, and never in front of it: a pet with nothing to
    // say is a pet that still got its XP.
    const line = deps.line ? await deps.line(found.meal.petId).catch(() => null) : null;
    return { ok: true, petId: found.meal.petId, xp, lens: found.meal.lensApplied, tx, line };
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
