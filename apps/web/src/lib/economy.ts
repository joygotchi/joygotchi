import { GAS, ONE_YOCTO, STAKE_CONTRACT } from '#lib/config';
import { formatAmount, parseAmount } from '#lib/near/amount';
import { viewFunction } from '#lib/near/rpc';
import { callFunction } from '#lib/near/tx';

/**
 * The AI-credit economy, as the browser sees it.
 *
 * Credits are a second resource alongside NEAR: pets staked in the lab earn
 * them by weight share, and they pay for feeding, items and inference. They
 * are never bought or sold here — the contract is the only thing that mints
 * them, and this module only reads and spends.
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

/** `pet-stake::get_pet_state` */
export type PetState = {
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

/** Credits as a person reads them: micro-credits in, a short decimal out. */
export const formatCredits = (raw: string | bigint, places = 3) =>
  formatAmount(raw, CREDIT_DECIMALS, places);

export const toMicroCredits = (credits: number) =>
  parseAmount(credits.toString(), CREDIT_DECIMALS);

// ── Views ────────────────────────────────────────────────────────────────────

export const getStakeAccount = (accountId: string) =>
  viewFunction<StakeAccount | null>(STAKE_CONTRACT, 'get_account', { account_id: accountId });

export const getPool = () => viewFunction<Pool>(STAKE_CONTRACT, 'get_pool');

export const getPetState = (petId: number) =>
  viewFunction<PetState>(STAKE_CONTRACT, 'get_pet_state', { pet_id: petId });

export const getInventory = (accountId: string) =>
  viewFunction<Array<[number, number]>>(STAKE_CONTRACT, 'get_inventory', {
    account_id: accountId
  });

export const getItemPrices = () =>
  viewFunction<Array<[number, string]>>(STAKE_CONTRACT, 'get_items');

export const miningAvailableAt = (accountId: string) =>
  viewFunction<string>(STAKE_CONTRACT, 'mining_available_at', { account_id: accountId });

/**
 * Credits a staked pet earns per day at the current pool size.
 *
 * Worth showing before someone stakes: the stream is a fixed budget split by
 * weight, so what a pet earns depends on everyone else, not on itself alone.
 */
export function creditsPerDay(weight: string | number, pool: Pool): number {
  const share = Number(weight);
  const total = Number(pool.total_weight);
  if (share <= 0 || total <= 0) return 0;

  const perSecond = (Number(pool.rate_per_second) * share) / total;
  return (perSecond * 86_400) / 10 ** CREDIT_DECIMALS;
}

// ── Calls ────────────────────────────────────────────────────────────────────

/**
 * Put a pet to work. Attaches 1 yoctoNEAR, which the contract requires so a
 * limited gameplay key cannot stake pets on its own.
 *
 * The ownership check runs in a cross-contract callback that logs and returns
 * `false` rather than panicking, so the transaction succeeds either way —
 * `assertReceiptsSucceeded` cannot catch this one, and the caller has to read
 * the logs. Hence `stakePet` below rather than a bare `callFunction`.
 */
export async function stakePet(petId: number) {
  const outcome = await callFunction(
    STAKE_CONTRACT,
    'stake_pet',
    { pet_id: petId },
    { gas: GAS.heavy, deposit: ONE_YOCTO }
  );

  const refused = (outcome.receipts_outcome ?? [])
    .flatMap((receipt) => receipt.outcome.logs)
    .find(
      (line) =>
        line.includes('That pet belongs to someone else') ||
        line.includes('Could not read the pet from the game contract')
    );
  if (refused) throw new Error(refused);

  return outcome;
}

export const unstakePet = (petId: number) =>
  callFunction(
    STAKE_CONTRACT,
    'unstake_pet',
    { pet_id: petId },
    { gas: GAS.heavy, deposit: ONE_YOCTO }
  );

/** Move earned credits into the spendable balance. */
export const claimCredits = () =>
  callFunction(STAKE_CONTRACT, 'claim_credits', {}, { gas: GAS.heavy });

/** Ten free credits, once per account, ever. */
export const claimFaucet = () =>
  callFunction(STAKE_CONTRACT, 'claim_faucet', {}, { gas: GAS.heavy });

/** A small top-up, once every six hours. */
export const claimMining = () =>
  callFunction(STAKE_CONTRACT, 'claim_mining', {}, { gas: GAS.heavy });

export const buyItem = (itemId: number, quantity = 1) =>
  callFunction(
    STAKE_CONTRACT,
    'buy_credit_item',
    { item_id: itemId, quantity },
    { gas: GAS.heavy }
  );

export const useItem = (itemId: number, petId: number) =>
  callFunction(STAKE_CONTRACT, 'use_item', { item_id: itemId, pet_id: petId }, { gas: GAS.heavy });

/**
 * Spend credits on an action.
 *
 * The contract charges its own configured price and ignores a client that
 * offers less, so the amount here is a floor the caller agrees to, not a price
 * the caller sets.
 */
export const spendCredits = (action: CreditAction, petId: number | null = null) =>
  callFunction(
    STAKE_CONTRACT,
    'spend_credits',
    { action, pet_id: petId, amount: toMicroCredits(ACTION_PRICE[action]) },
    { gas: GAS.heavy }
  );
