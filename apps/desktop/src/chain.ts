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

export async function viewFunction<T>(
  network: string,
  contractId: string,
  method: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const url = RPC[network as keyof typeof RPC] ?? RPC.testnet;

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

export const getInventory = (network: string, stake: string, accountId: string) =>
  viewFunction<Array<[number, number]>>(network, stake, 'get_inventory', {
    account_id: accountId
  });
