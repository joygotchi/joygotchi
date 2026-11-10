/**
 * Which pets to feed, and in what order.
 *
 * Kept apart from everything that touches the network so it can be tested
 * without one. This is the part that spends other people's credits, and the
 * rules it enforces are the promise the auto-feed switch makes: never more
 * than the budget, never a pet that is not hungry, never a meal the contract
 * would refuse.
 */

/** `pet-stake::get_auto_feed_accounts` */
export type AutoFeedAccount = {
  account_id: string;
  budget: string;
  spent: string;
  /** Budget left this window, already capped by the credit balance. */
  available: string;
  credit_balance: string;
  window: string;
};

/** The fields of `game::get_pets_for_owner` this needs. */
export type OwnedPet = {
  pet_id: number;
  owner_id: string;
  seconds_until_starving: string;
  locked?: boolean;
};

export type Meal = { accountId: string; petId: number; secondsLeft: number };

export type Rules = {
  /** What one `auto_feed` costs, in micro-credits. */
  price: number;
  /** How long a meal buys, in seconds. */
  gives: number;
  /**
   * Feed when a pet has less than this left.
   *
   * Set to the meal's own length by default. Feeding earlier is not kinder:
   * the contract caps banked food at seven days and throws the rest away, so
   * a meal given at six days left is mostly spent on nothing. Feeding later
   * is the real risk, and this leaves a full meal's worth of margin before
   * the deadline — one missed poll does not kill a pet.
   */
  feedBelow: number;
};

export const DEFAULT_RULES: Rules = {
  price: 15_000,
  gives: 12 * 60 * 60,
  feedBelow: 12 * 60 * 60
};

/**
 * Decide the round's meals.
 *
 * `petsOf` is passed in rather than fetched so the caller owns every network
 * call and this stays a pure function of what it was told.
 */
export function decideMeals(
  accounts: readonly AutoFeedAccount[],
  petsOf: (accountId: string) => readonly OwnedPet[],
  rules: Rules = DEFAULT_RULES
): Meal[] {
  const meals: Meal[] = [];

  for (const account of accounts) {
    const available = toNumber(account.available);
    // The view caps `available` by the credit balance already, but a budget
    // that cannot buy one meal is not worth a round trip.
    let left = Math.floor(available / rules.price);
    if (left <= 0) continue;

    const hungry = petsOf(account.account_id)
      .filter((pet) => pet.owner_id === account.account_id)
      .map((pet) => ({ pet, secondsLeft: toNumber(pet.seconds_until_starving) }))
      // Zero means it has already starved, and `feed_from_stake` refuses
      // those — it takes a revival item, which costs NEAR and is nobody's
      // decision to make on somebody's behalf.
      .filter(({ secondsLeft }) => secondsLeft > 0 && secondsLeft < rules.feedBelow)
      // Hungriest first: if the budget runs out, it should run out on the
      // pets with the most time left.
      .sort((a, b) => a.secondsLeft - b.secondsLeft);

    for (const { pet, secondsLeft } of hungry) {
      if (left <= 0) break;
      meals.push({ accountId: account.account_id, petId: pet.pet_id, secondsLeft });
      left -= 1;
    }
  }

  return meals;
}

function toNumber(raw: string | undefined): number {
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}
