import type { PetStatus, StakeAccount } from '@joygotchi/pet';

/**
 * Read the chain from the desktop app.
 *
 * Reads only. Signing needs a key, and the app does not have one yet — see
 * `PetPanel.svelte` for what that costs and why it is not a stored full-access
 * key.
 *
 * The contract ids come from the installed `pet.json` rather than from a
 * constant here, so a pet minted against a different deployment still resolves
 * against the deployment it came from.
 */
const RPC = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com'
} as const;

/** The staking contract that pairs with a given game contract. */
export const stakeContractFor = (gameContract: string) =>
  gameContract.replace(/^jg-game-/, 'jg-stake-');

/**
 * How long an identical read is reused.
 *
 * The window polls every pet on the contract every twelve seconds for the
 * battle watcher, and the panel asks for the same list again to build its
 * target list. Two callers wanting the same answer a moment apart is the
 * normal case here, not an edge one.
 */
const CACHE_MS = 4_000;

type Entry = { at: number; value: Promise<unknown> };
const inFlight = new Map<string, Entry>();

/** Transient: worth another go. A contract panic is not. */
function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/panic|Cannot deserialize|Unknown|not enough|require/i.test(message)) return false;
  return /HTTP (408|425|429|5\d\d)|returned nothing|refused|fetch|network|timeout|aborted/i.test(
    message
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rawView<T>(
  url: string,
  contractId: string,
  method: string,
  args: Record<string, unknown>
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'joygotchi-desktop',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args))
      }
    })
  });

  if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);

  const body = (await response.json()) as {
    result?: { result: number[]; error?: string };
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? 'the RPC refused the query');
  if (!body.result) throw new Error('the RPC returned nothing');
  if (body.result.error) throw new Error(body.result.error);

  const text = new TextDecoder().decode(new Uint8Array(body.result.result));
  return (text === '' ? null : JSON.parse(text)) as T;
}

/**
 * Read the chain, with the two things a public RPC makes necessary.
 *
 * **Retry.** A rate-limited or momentarily unreachable node used to surface
 * as a red error in the panel, indistinguishable from a contract that had
 * genuinely broken — which cost a real hour of debugging once. Only
 * transient failures are retried: a contract panic is an answer, and
 * repeating the question does not change it.
 *
 * **Coalescing.** Identical reads inside a few seconds share one request and
 * one answer. The window and the panel both want every pet on the contract,
 * on their own timers, and before this they each asked.
 */
export async function viewFunction<T>(
  network: string,
  contractId: string,
  method: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const url = RPC[network as keyof typeof RPC] ?? RPC.testnet;
  const key = `${url}|${contractId}|${method}|${JSON.stringify(args)}`;

  const cached = inFlight.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value as Promise<T>;

  const value = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await rawView<T>(url, contractId, method, args);
      } catch (error) {
        lastError = error;
        if (!isTransient(error)) throw error;
        // 300ms, then 900ms. Long enough for a rate limit window to pass,
        // short enough that the panel is not visibly stuck.
        await wait(300 * 3 ** attempt);
      }
    }
    throw lastError;
  })();

  inFlight.set(key, { at: Date.now(), value });
  // A failure must not be served to the next caller for four seconds.
  value.catch(() => inFlight.delete(key));
  return value;
}

/** For tests, and for a forced refresh after something is signed. */
export function forgetReads() {
  inFlight.clear();
}

export const getStakeAccount = (network: string, stake: string, accountId: string) =>
  viewFunction<StakeAccount | null>(network, stake, 'get_account', { account_id: accountId });

export const getPetStatus = (network: string, stake: string, petId: number) =>
  viewFunction<PetStatus>(network, stake, 'get_pet_state', { pet_id: petId });

/**
 * Who owns the pet right now.
 *
 * `pet.json` records the owner at install time, which is wrong the moment a
 * pet is sold — and the panel decides whether to show its buttons from this.
 */
export async function getPetOwner(
  network: string,
  gameContract: string,
  petId: number
): Promise<string | null> {
  const pet = await viewFunction<{ owner_id?: string } | null>(network, gameContract, 'get_pet', {
    pet_id: petId
  }).catch(() => null);
  return pet?.owner_id ?? null;
}

/** A pet as the game contract describes it, for picking a fight. */
export type ChainPetSummary = {
  pet_id: number;
  owner_id: string;
  name: string;
  rarity: string;
  level: number;
  star: number;
  locked?: boolean;
  seconds_until_starving?: string;
  last_attacked?: string;
  /**
   * Which drawing this pet is. `get_pet` has always returned both — they were
   * simply missing from this type, so the battle scene drew every opponent as
   * a phase-one black dragon by accident rather than by decision.
   */
  category?: string;
  evolution_phase?: number;
  /** Shields carried. Each one absorbs a hit before anything else does. */
  shield?: number;
  /**
   * Set on whoever **won** the last fight, not on whoever started it. Both
   * this and `last_attacked` are stamped with the same block timestamp, which
   * is what lets `detectBattle` pair the two sides without an indexer.
   */
  last_attack_used?: string;
};

/**
 * Every pet on the contract, for the target list.
 *
 * There is no paged view, so this walks the token ids. Fine while the whole
 * population fits on one screen; when it does not, the contract gets a paged
 * view rather than this getting clever about it.
 */
export async function listPets(
  network: string,
  gameContract: string,
  limit = 24
): Promise<ChainPetSummary[]> {
  const supply = Number(
    await viewFunction<string>(network, gameContract, 'nft_total_supply').catch(() => '0')
  );
  if (!Number.isFinite(supply) || supply === 0) return [];

  const ids: number[] = [];
  for (let id = supply; id >= 1 && ids.length < limit; id--) ids.push(id);

  const pets = await Promise.all(
    ids.map((pet_id) =>
      viewFunction<ChainPetSummary | null>(network, gameContract, 'get_pet', { pet_id }).catch(
        () => null
      )
    )
  );
  return pets.filter((pet): pet is ChainPetSummary => pet !== null);
}

/**
 * Whether the lab will let this pet be attacked.
 *
 * The game contract has its own checks on top — cooldowns, starvation, who
 * owns what — so a true here is necessary and not sufficient. It is enough to
 * keep obviously impossible targets off the list.
 */
export const isAttackable = (network: string, stake: string, petId: number) =>
  viewFunction<boolean>(network, stake, 'is_attackable', { pet_id: petId }).catch(() => false);

/**
 * The game's own shop — the one paid in NEAR.
 *
 * Separate from the credit items on the staking contract, and the only thing
 * in the system that moves a pet's starvation deadline. `spend_credits`
 * records a meal and charges for it; this is what actually feeds.
 */
export type ShopItem = {
  item_id: number;
  name: string;
  price: string;
  time_extension: number;
  xp: number;
  shield: number;
  is_revival: boolean;
};

export const getShop = (network: string, gameContract: string) =>
  viewFunction<ShopItem[]>(network, gameContract, 'get_shop', {});

export const getInventory = (network: string, stake: string, accountId: string) =>
  viewFunction<Array<[number, number]>>(network, stake, 'get_inventory', {
    account_id: accountId
  });
