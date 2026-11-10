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
  /** Micro-credits the oracle may spend auto-feeding, per 24-hour window. */
  auto_feed_budget: string;
  /** Spent in the window that is open now. */
  auto_feed_spent?: string;
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
  /** A real meal: twelve hours on the clock, charged in credits. */
  feed: 0.015,
  /**
   * Bringing a starved pet back, which used to be Holy Water at 0.5 NEAR.
   * Five meals, the same ratio Holy Water had against Beef — so the decision
   * keeps its shape now that there is only one currency to make it in.
   */
  revive: 0.075,
  train: 0.008,
  evolve: 0.5,
  craft_item: 0.02,
  chat: 0.001,
  auto_feed: 0.015
} as const;

export type CreditAction = keyof typeof ACTION_PRICE;

/**
 * Auto-feed, as the contract prices it.
 *
 * One feed costs `ACTION_PRICE.auto_feed` and moves the starving deadline by
 * `AUTO_FEED_HOURS`. Two of them cover a day, which is what a budget has to
 * afford before "auto" means anything.
 */
/**
 * Evolving, as the game contract gates it.
 *
 * Phase 1 needs level 5, phase 2 needs 10, and four is the end of it. Mirrored
 * here so a button can be dark before it is pressed rather than after: the
 * contract refuses and refunds, but a refund the player has to notice is a
 * worse answer than a button that explains itself.
 */
export const MAX_EVOLUTION_PHASE = 4;

export function levelToEvolve(phase: number): number | null {
  if (phase >= MAX_EVOLUTION_PHASE) return null;
  return phase * 5;
}

export const AUTO_FEED_HOURS = 12;
export const AUTO_FEED_A_DAY = 2;
/**
 * A day's cover for **one** pet, with one feed of headroom for a window that
 * starts late. Prefer `autoFeedBudgetFor`: the budget is per account, and an
 * account can own more than one pet.
 */
export const AUTO_FEED_DAILY_BUDGET = ACTION_PRICE.auto_feed * (AUTO_FEED_A_DAY + 1);

/**
 * A day's auto-feed allowance for an account, by how many pets it owns.
 *
 * The budget the contract enforces is per account, but this used to be sized
 * for a single pet — so switching auto-feed on with five pets bought cover
 * for the first two the oracle happened to reach and nothing for the other
 * three. Nothing reported it, either: the contract stops at the allowance it
 * was given, which is exactly what it should do.
 *
 * Returned in micro-credits, computed in integers. The rate times a count is
 * the sort of arithmetic that turns 0.165 into 0.16500000000000001, and the
 * one place that number must be exact is on its way to a contract.
 */
export function autoFeedBudgetFor(pets: number): string {
  const covered = Math.max(1, Math.floor(pets));
  const meals = BigInt(covered * AUTO_FEED_A_DAY + 1);
  return String(BigInt(toMicroCredits(ACTION_PRICE.auto_feed)) * meals);
}

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

/**
 * What a desktop session key may call, split by the contract it lives on.
 *
 * A NEAR function-call key is bound to exactly one contract, so playing from
 * the desktop needs two of them: the lab, where credits are spent, and the
 * game, where pets fight and evolve. Both are granted in one trip through the
 * wallet; this is the list both ends agree on.
 */
export const STAKE_METHODS = [
  'claim_credits',
  'spend_credits',
  /*
   * Buying from the shop is granted; buying from the market is not, and the
   * difference is who sets the price.
   *
   * Everything a session key may spend is spent at a price the contract
   * fixed, so the worst a stolen key can do is bounded by prices nobody
   * holding it chose. `buy_listing` pays whatever a seller asked, and the
   * seller can be the thief: list a Tonic at thirty credits, buy it with the
   * stolen key, walk away with the balance. `list_item` is the same hole
   * from the other side — list the kit for nothing and collect it.
   *
   * So the market goes through the wallet, like `buy_item` and `list_pet`.
   */
  'buy_credit_item',
  'use_item',
  'claim_mining',
  'claim_faucet',
  // Both of these used to demand one yoctoNEAR and so could not be here at
  // all: a function-call key may never attach a deposit. The contract gave
  // that up, because the guard bought less than it cost — neither call moves
  // the NFT or any balance, so a stolen key can only put a pet in or out of
  // the lab, while the deposit put a browser round trip in front of the
  // action players take most.
  'stake_pet',
  'unstake_pet',
  // The meal that actually moves the starvation clock. The game contract's
  // shop does the same thing for NEAR and is payable, so a session key can
  // never reach it; this one is priced in credits and takes no deposit,
  // which is the whole reason it exists.
  'feed_pet',
  // Setting your own auto-feed budget takes no deposit, so the app can sign
  // it. Turning the pet's survival over to the oracle should not need a trip
  // through a browser — the point of it is to stop needing you at all.
  'set_auto_feed_budget',
  // Coming back from starvation, priced in credits. Holy Water does the same
  // thing for NEAR through the payable shop, which no session key can reach,
  // so losing a pet used to mean a browser round trip and a token the player
  // never earned by playing. This one takes no deposit.
  'revive_pet',
  // The next phase, for the price the contract has carried since the sinks
  // were seeded. Nothing spent it until now.
  // The next phase, for the price the contract has carried since the sinks
  // were seeded. Nothing spent it until now.
  //
  // Safe to grant for the same reason the rest of this list is: the contract
  // sets the price. The item market is not here and must not be — see the
  // note under `buy_credit_item`.
  'evolve_pet'
] as const;

/**
 * Deliberately short. `list_pet` and `buy_pet` are payable and could not be
 * called anyway; `nft_transfer` is payable for the same reason, which is the
 * protocol keeping a session key from giving your pet away.
 */
export const GAME_METHODS = ['attack', 'evolve'] as const;

/**
 * The accessory contract's own list.
 *
 * `mint` is not here and cannot be: it is payable, so a function-call key
 * may never carry it. Putting a hat on is free, and there is no reason it
 * should cost a trip through a browser.
 */
export const ACCESSORY_METHODS = ['equip', 'unequip'] as const;

export type SessionMethod =
  | (typeof STAKE_METHODS)[number]
  | (typeof GAME_METHODS)[number]
  | (typeof ACCESSORY_METHODS)[number];

/** Which of the two contracts a method belongs to. */
export const contractForMethod = (
  method: string,
  contracts: { stake: string; game: string; accessory?: string }
): string | null => {
  if ((STAKE_METHODS as readonly string[]).includes(method)) return contracts.stake;
  if ((GAME_METHODS as readonly string[]).includes(method)) return contracts.game;
  if ((ACCESSORY_METHODS as readonly string[]).includes(method)) {
    return contracts.accessory ?? null;
  }
  return null;
};

/** Which stored key signs for a method: one name per contract. */
export const slotForMethod = (method: string): 'lab' | 'game' | 'accessory' | null => {
  if ((STAKE_METHODS as readonly string[]).includes(method)) return 'lab';
  if ((GAME_METHODS as readonly string[]).includes(method)) return 'game';
  if ((ACCESSORY_METHODS as readonly string[]).includes(method)) return 'accessory';
  return null;
};
