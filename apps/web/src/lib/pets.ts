import { GAME_CONTRACT, GAS, MINT_PRICE_NEAR, NETWORK } from '#lib/config';
import { formatNear, parseNear } from '#lib/near/amount';
import { viewFunction } from '#lib/near/rpc';
import { callFunction, txEvents } from '#lib/near/tx';
import {
  petSlug,
  toPetPackage,
  type ChainPet,
  type ChainSpecies,
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
  /** The species id. Any registered one, not only the two we ship. */
  kind: string;
  pkg: PetPackage;
  /**
   * The species' registered art, one url per phase.
   *
   * Every page that draws a pet reads this. They used to build
   * `/assets/animation/<kind>/<phase>.gif` themselves — six copies of a rule
   * that was true while there were two species compiled into the app, and a
   * 404 for every species registered since. The two built-ins are in the
   * registry too, with absolute urls, so there is no special case here.
   */
  art: string[];
  /** The pet's market listing, when it is for sale. */
  listing: PetListing | null;
};

/** A pet for sale on the game contract's own market. Price in yoctoNEAR. */
export type PetListing = {
  pet_id: number;
  seller_id: string;
  price: string;
  listed_at: string;
};

const chain = () => ({ network: NETWORK, contract: GAME_CONTRACT });

function decorate(
  pet: ChainPet,
  species: ChainSpecies[],
  listings: PetListing[] = []
): GalleryPet {
  const pkg = toPetPackage(pet, chain());
  const found = species.find((one) => one.id === pet.category);
  return {
    ...pet,
    slug: pkg.slug,
    kind: pkg.kind,
    pkg,
    // A species the registry does not know should not happen — a pet cannot
    // be minted without one — but an empty list draws nothing rather than
    // throwing on a page whose job is to show a pet.
    art: found?.art ?? [],
    listing: listings.find((one) => Number(one.pet_id) === Number(pet.pet_id)) ?? null
  };
}

/**
 * The drawing for a phase, with phase 4 falling back to the last one drawn.
 *
 * The same rule the contract applies in `Species::art_for`, because the two
 * have to agree about which picture a wallet and this page are showing.
 */
export function artFor(pet: GalleryPet, phase = Number(pet.evolution_phase ?? 1) || 1): string {
  if (pet.art.length === 0) return '';
  return pet.art[Math.min(Math.max(phase, 1), pet.art.length) - 1] ?? pet.art[0]!;
}

/**
 * Every pet on the contract, newest first.
 *
 * There is no `get_pets` on the contract, so this walks the NEP-171 token
 * list and reads each pet. Fine for a gallery of this size; when it stops
 * being fine, the contract gets a paged view rather than this getting clever.
 */
export async function listPets(limit = 60): Promise<GalleryPet[]> {
  /*
   * Ask the contract which pets exist rather than counting down from the
   * supply. Ids stop being contiguous the moment a pet is burned — a retired
   * species takes its pets with it — and counting `supply..1` then skips the
   * newest pets and asks for ones that are gone.
   */
  const PAGE = 100;
  const pets: ChainPet[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await viewFunction<ChainPet[]>(GAME_CONTRACT, 'get_pets', {
      from_index: from,
      limit: PAGE
    });
    pets.push(...page);
    if (page.length < PAGE) break;
  }

  // The contract's own order is storage order, which a burn reshuffles.
  pets.sort((a, b) => Number(b.pet_id) - Number(a.pet_id));

  const [species, listings] = await Promise.all([listSpecies(), listListings()]);
  return pets.slice(0, limit).map((one) => decorate(one, species, listings));
}

export async function getPet(petId: number): Promise<GalleryPet | null> {
  const pet = await viewFunction<ChainPet | null>(GAME_CONTRACT, 'get_pet', {
    pet_id: petId
  }).catch(() => null);
  if (!pet) return null;
  const [species, listing] = await Promise.all([getSpecies(pet.category), getListing(petId)]);
  return decorate(pet, species ? [species] : [], listing ? [listing] : []);
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
  const [species, listings] = await Promise.all([listSpecies(), listListings()]);
  return pets.map((one) => decorate(one, species, listings));
}

/**
 * Every species that can be minted, read from the contract.
 *
 * This used to be the `PET_KINDS` constant, which meant a mint form went
 * stale the moment somebody registered an animal — and, before the
 * registry, that a new animal needed a deploy of this app.
 */
export async function listSpecies(): Promise<ChainSpecies[]> {
  return viewFunction<ChainSpecies[]>(GAME_CONTRACT, 'list_species').catch(() => []);
}

export async function getSpecies(id: string): Promise<ChainSpecies | null> {
  return viewFunction<ChainSpecies | null>(GAME_CONTRACT, 'get_species', { id }).catch(
    () => null
  );
}

/** What registering a species costs, in NEAR. Asked, never assumed. */
export async function speciesPriceNear(): Promise<string> {
  const price = await viewFunction<string>(GAME_CONTRACT, 'get_species_price').catch(
    () => null
  );
  return price ? formatNear(price) : '5';
}

/**
 * Register a species, paying in NEAR.
 *
 * The contract checks the id and every url again; this is not the place
 * that enforces them. What the caller gains by checking first is that a
 * refused species costs nothing — the deposit is only attached to a call
 * that the same rules say will pass.
 */
export async function createSpecies(
  id: string,
  name: string,
  art: string[],
  priceNear: string
): Promise<string> {
  await callFunction(
    GAME_CONTRACT,
    'create_species',
    { id, name, art },
    { gas: GAS.heavy, deposit: parseNear(priceNear) }
  );
  return id;
}


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
export async function mintPet(name: string, kind: string): Promise<number> {
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

/**
 * Put a pet to work earning AI credit.
 *
 * No deposit. It used to send one yoctoNEAR, and now that the contract is not
 * payable, sending any would make the call fail outright — a non-payable
 * method rejects an attached deposit rather than ignoring it.
 */
export async function stakePet(stakeContract: string, petId: number) {
  return callFunction(stakeContract, 'stake_pet', { pet_id: petId }, { gas: GAS.heavy });
}

export const mintPriceNear = MINT_PRICE_NEAR;

// ── Pet market ───────────────────────────────────────────────────────────────
//
// The game contract keeps its own listings, so a sale is one call that moves
// the token, pays the seller, sends the fee to the treasury and returns any
// change. Every write here goes through the wallet: a sale moves NEAR at a
// price somebody else set, which a session key must never sign.

export async function getListing(petId: number): Promise<PetListing | null> {
  return viewFunction<PetListing | null>(GAME_CONTRACT, 'get_pet_listing', {
    pet_id: petId
  }).catch(() => null);
}

/** Every listing, paged until the contract runs out. */
export async function listListings(): Promise<PetListing[]> {
  const PAGE = 100;
  const all: PetListing[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await viewFunction<PetListing[]>(GAME_CONTRACT, 'get_pet_listings', {
      from_index: from,
      limit: PAGE
    }).catch(() => [] as PetListing[]);
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

/** A past sale of a pet. Price in yoctoNEAR, time in nanoseconds. */
export type PetSale = { price: string; seller_id: string; buyer_id: string; sold_at: string };

/** The pet's last few sales, newest first. Empty for a contract without them. */
export async function getPetSales(petId: number): Promise<PetSale[]> {
  return viewFunction<PetSale[]>(GAME_CONTRACT, 'get_pet_sales', { pet_id: petId }).catch(
    () => [] as PetSale[]
  );
}

/** The market's cut in basis points, read from the contract. */
export async function marketFeeBps(): Promise<number> {
  const config = await viewFunction<{ market_fee_bps?: number }>(GAME_CONTRACT, 'get_config').catch(
    () => ({}) as { market_fee_bps?: number }
  );
  return Number(config.market_fee_bps ?? 0);
}

/** Offer a pet for sale. `priceNear` is a decimal string, e.g. `"3.5"`. */
export async function listPet(petId: number, priceNear: string) {
  const price = parseNear(priceNear);
  if (BigInt(price) <= 0n) throw new Error('Set a price above zero');
  return callFunction(
    GAME_CONTRACT,
    'list_pet',
    { pet_id: petId, price },
    { gas: GAS.call, deposit: '1' }
  );
}

export async function unlistPet(petId: number) {
  return callFunction(GAME_CONTRACT, 'unlist_pet', { pet_id: petId }, { gas: GAS.call, deposit: '1' });
}

/** Buy a listed pet, attaching exactly the asking price in yoctoNEAR. */
export async function buyPet(listing: PetListing) {
  return callFunction(
    GAME_CONTRACT,
    'buy_pet',
    { pet_id: Number(listing.pet_id) },
    { gas: GAS.heavy, deposit: listing.price }
  );
}
