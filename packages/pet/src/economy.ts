/**
 * The AI-credit economy: prices, items, shapes and sums.
 *
 * Nothing here signs or fetches. The desktop app is where a player acts on
 * their pet and the website is a gallery, so the calls live with the wallet
 * and only the vocabulary is shared — which is also what keeps the two from
 * disagreeing about what a Tonic costs.
 *
 * Credits are a second resource alongside NEAR: pets staked in the lab earn
 * them by weight share, and they pay for feeding, items and inference.
 *
 * Every number below exists twice, here and in `contracts/pet-stake`. The
 * contract charges its own price whatever the client sends, so a drift makes
 * the UI wrong rather than the ledger wrong — but it still makes the UI wrong,
 * which is why the tests pin both ends.
 */

export const CREDIT_DECIMALS = 6;

/** `pet-stake::get_account` */
export type StakeAccount = {
  account_id: string;
  staked_pets: number[];
  weight: string;
  credit_balance: string;
  pending_credits: string;
  auto_feed_budget: string;
  last_claim_at: string;
  items: Array<[number, number]>;
};

/** `pet-stake::get_pool` */
export type Pool = {
  total_weight: string;
  epoch_budget: string;
  rate_per_second: string;
  staked_pets: number;
  total_distributed: string;
  total_spent: string;
  sale_reserve: string;
  paused: boolean;
};

/**
 * `pet-stake::get_pet_state` — a pet's standing in the lab.
 *
 * Not `PetState`: that name belongs to the animation states, and two different
 * things called the same thing in one package is how someone ends up importing
 * the wrong one and finding out at runtime.
 */
export type PetStatus = {
  pet_id: number;
  wounded_until: string;
  shielded_until: string;
  lens_feeds_left: number;
  star_guard: boolean;
  staked: boolean;
  attackable: boolean;
};

export const ITEMS = {
  101: {
    id: 101,
    name: 'Tonic',
    blurb: 'Clears a wound, so a beaten pet can fight again before morning.'
  },
  102: { id: 102, name: 'Ward', blurb: 'Nobody can attack this pet for a day.' },
  103: { id: 103, name: 'Focus Lens', blurb: 'The next ten feeds earn bonus XP.' },
  104: { id: 104, name: 'Charm', blurb: 'Protects a star the next time the pet loses.' }
} as const;

export type ItemId = keyof typeof ITEMS;

export const itemName = (id: number) => ITEMS[id as ItemId]?.name ?? `Item ${id}`;

/** What an action costs, in whole credits. Mirrors the contract's defaults. */
export const ACTION_PRICE = {
  ai_feed: 0.002,
  train: 0.008,
  evolve: 0.5,
  craft_item: 0.02,
  chat: 0.001,
  revive: 1,
  auto_feed: 0.015
} as const;

export type CreditAction = keyof typeof ACTION_PRICE;

/**
 * Credits as a person reads them: micro-credits in, a short decimal out.
 *
 * BigInt rather than Number, and truncating rather than rounding — the same
 * rule as NEAR amounts. Showing someone more credits than they hold is the
 * direction that costs them a failed transaction.
 */
export function formatCredits(raw: string | bigint, places = 3): string {
  const units = BigInt(raw);
  const divisor = 10n ** BigInt(CREDIT_DECIMALS);
  const whole = units / divisor;
  if (places === 0) return String(whole);

  const digits = (units % divisor)
    .toString()
    .padStart(CREDIT_DECIMALS, '0')
    .slice(0, places)
    .replace(/0+$/, '');
  return digits ? `${whole}.${digits}` : String(whole);
}

/** A decimal number of credits as the micro-credits the contract counts in. */
export function toMicroCredits(credits: number): string {
  const [whole = '0', fraction = ''] = credits.toString().split('.');
  const padded = (fraction + '0'.repeat(CREDIT_DECIMALS)).slice(0, CREDIT_DECIMALS);
  return String(BigInt(whole) * 10n ** BigInt(CREDIT_DECIMALS) + BigInt(padded));
}
