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
/**
 * More than one node per network, tried in order.
 *
 * A single public endpoint is a single point of failure for a window that
 * reads every pet on the contract every twelve seconds. When it rate-limits,
 * every call fails at once and the panel looks like a broken contract.
 */
const RPC = {
  testnet: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org']
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
  const urls = RPC[network as keyof typeof RPC] ?? RPC.testnet;
  // Keyed on the network, not the node: a read that failed over must still
  // be the same read to the next caller.
  const key = `${network}|${contractId}|${method}|${JSON.stringify(args)}`;

  const cached = inFlight.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value as Promise<T>;

  const value = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      // A different node each time round, so a rate-limited one is not asked
      // three times in a row.
      const url = urls[attempt % urls.length] ?? urls[0];
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
/**
 * One pet, as the chain sees it.
 *
 * This used to be `getPetOwner`, which made the same call and threw away
 * everything but the owner — including how long the pet has left, which the
 * panel then had no way to know.
 */
export const getPetOnChain = (network: string, gameContract: string, petId: number) =>
  viewFunction<ChainPetSummary | null>(network, gameContract, 'get_pet', {
    pet_id: petId
  }).catch(() => null);

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
 * Every pet on the contract, in one call.
 *
 * This used to walk the token ids — `nft_total_supply`, then one `get_pet`
 * each. Eight pets made it nine requests, and the window runs it every
 * twelve seconds for the battle watcher while the panel runs it again for
 * the target list. The free RPC tiers answer about eight requests before
 * returning 429, measured on both of them, so the app spent its time rate-
 * limiting itself and reporting the result as a broken contract. A hundred
 * pets would have made it a hundred and one requests.
 *
 * `get_pets` is a paged view added for this. One request, capped at a
 * hundred by the contract.
 */
export async function listPets(
  network: string,
  gameContract: string,
  limit = 50
): Promise<ChainPetSummary[]> {
  const pets = await viewFunction<ChainPetSummary[] | null>(network, gameContract, 'get_pets', {
    from_index: 0,
    limit
  });
  return pets ?? [];
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

/**
 * When mining is allowed again, in nanoseconds; 0 means now.
 *
 * The contract has had this view all along and the app never asked, so it
 * offered Mine on a six-hour cooldown and let the contract do the refusing.
 */
export const miningAvailableAt = (network: string, stake: string, accountId: string) =>
  viewFunction<string>(network, stake, 'mining_available_at', { account_id: accountId });

export const getInventory = (network: string, stake: string, accountId: string) =>
  viewFunction<Array<[number, number]>>(network, stake, 'get_inventory', {
    account_id: accountId
  });
