import { GAME_CONTRACT, GAS, MINT_PRICE_NEAR, NETWORK, ONE_YOCTO } from '#lib/config';
import { parseNear } from '#lib/near/amount';
import { viewFunction } from '#lib/near/rpc';
import { callFunction, txEvents } from '#lib/near/tx';
import {
  PET_KINDS,
  petSlug,
  toPetPackage,
  type ChainPet,
  type PetKind,
  type PetPackage
} from '@joygotchi/pet';

/**
 * The pet as a page shows it: what the chain said, plus what we derive.
 *
 * `kind` and `rarity` are lifted out of the package because the contract's
 * `category` is a free string and its `rarity` is cased differently in
 * different places — the package is where those get normalised, and a card
 * should not have to know that.
 */
export type GalleryPet = ChainPet & {
  slug: string;
  kind: PetKind;
  pkg: PetPackage;
};

const chain = () => ({ network: NETWORK, contract: GAME_CONTRACT });

function decorate(pet: ChainPet): GalleryPet {
  const pkg = toPetPackage(pet, chain());
  return { ...pet, slug: pkg.slug, kind: pkg.kind, pkg };
}

/**
 * Every pet on the contract, newest first.
 *
 * There is no `get_pets` on the contract, so this walks the NEP-171 token
 * list and reads each pet. Fine for a gallery of this size; when it stops
 * being fine, the contract gets a paged view rather than this getting clever.
 */
export async function listPets(limit = 60): Promise<GalleryPet[]> {
  const supply = await viewFunction<string>(GAME_CONTRACT, 'nft_total_supply');
  const total = Number(supply);
  if (!Number.isFinite(total) || total === 0) return [];

  const ids: number[] = [];
  for (let id = total; id >= 1 && ids.length < limit; id--) ids.push(id);

  const pets = await Promise.all(
    ids.map((pet_id) =>
      viewFunction<ChainPet | null>(GAME_CONTRACT, 'get_pet', { pet_id }).catch(() => null)
    )
  );

  return pets.filter((pet): pet is ChainPet => pet !== null).map(decorate);
}

export async function getPet(petId: number): Promise<GalleryPet | null> {
  const pet = await viewFunction<ChainPet | null>(GAME_CONTRACT, 'get_pet', {
    pet_id: petId
  }).catch(() => null);
  return pet ? decorate(pet) : null;
}

/** A pet by its slug, which carries the id: `ancalagon-3` → 3. */
export async function getPetBySlug(slug: string): Promise<GalleryPet | null> {
  const id = Number(slug.split('-').pop());
  if (!Number.isInteger(id) || id < 1) return null;

  const pet = await getPet(id);
  // The slug has to match, or `/pets/anything-3` would serve pet 3 under any
  // name and every one of those URLs would get indexed separately.
  return pet && pet.slug === slug ? pet : null;
}

export async function petsOf(accountId: string): Promise<GalleryPet[]> {
  const pets = await viewFunction<ChainPet[]>(GAME_CONTRACT, 'get_pets_for_owner', {
    account_id: accountId
  }).catch(() => [] as ChainPet[]);
  return pets.map(decorate);
}

export const KINDS = PET_KINDS;

/**
 * Mint a pet, paying in NEAR.
 *
 * Straight to the game contract while NEAR Intents is not wired up: one
 * transaction, one chain, testnet NEAR from the faucet. The mint-router path
 * that takes ZEC or SOL through 1Click lands on the same `create_pet_for`, so
 * adding it later does not change anything a page here does.
 *
 * Returns the new pet's id, read out of the contract's own event rather than
 * guessed from the supply: two people minting in the same block would both
 * guess the same wrong number.
 */
export async function mintPet(name: string, kind: PetKind): Promise<number> {
  const outcome = await callFunction(
    GAME_CONTRACT,
    'create_pet',
    { name, category: kind },
    { gas: GAS.heavy, deposit: parseNear(MINT_PRICE_NEAR) }
  );

  for (const event of txEvents(outcome)) {
    if (event.event !== 'pet_minted') continue;
    const data = event.data[0] as { pet_id?: number } | undefined;
    if (typeof data?.pet_id === 'number') return data.pet_id;
  }

  throw new Error('The mint went through but the contract reported no pet id');
}

/** Put a pet to work earning AI credit. Needs 1 yoctoNEAR as confirmation. */
export async function stakePet(stakeContract: string, petId: number) {
  return callFunction(
    stakeContract,
    'stake_pet',
    { pet_id: petId },
    { gas: GAS.heavy, deposit: ONE_YOCTO }
  );
}

export const mintPriceNear = MINT_PRICE_NEAR;
