import { encodeInstallCode } from './install-code.js';
import { PET_STATES, type PetState } from './states.js';

/**
 * A pet on disk: `pet.json` plus its art, under
 * `~/.joygotchi/pets/<slug>/`.
 *
 * The shape follows petdex's pet package where it can — `slug`,
 * `displayName`, `kind`, `frame`, `spriteVersion` — so a spritesheet made for
 * one renders in the other. What JOYGOTCHI adds is the chain: a pet here is an
 * NFT, so the package records which contract and which token it came from, and
 * who owned it at install time.
 */
export type PetPackage = {
  format: 'joygotchi/1';
  slug: string;
  displayName: string;
  /** Token id on the game contract. The install code encodes exactly this. */
  petId: number;
  installCode: string;
  /**
   * The species id, which is the `category` on the game contract. Any
   * registered species, not only the ones in `PET_KINDS`.
   */
  kind: string;
  rarity: Rarity;
  level: number;
  star: number;
  evolutionPhase: EvolutionPhase;
  /** Where it lives on chain, so the CLI and the app can read it back. */
  chain: {
    network: 'testnet' | 'mainnet';
    contract: string;
    /** Owner at install time. Verify against the chain before trusting it. */
    owner: string;
  };
  /** Frame size, for a sprite atlas. Unused by the GIF renderer. */
  frame: { width: number; height: number };
  spriteVersion: 1 | 2;
  /**
   * Art per state, as paths relative to the package folder.
   *
   * Every state has an entry, but several point at the same file: the dragons
   * only have idle loops drawn for them, so the desktop app animates motion in
   * CSS over an idle frame rather than pretend there are nine loops. A pet that
   * ships a real nine-row atlas can point each state at its own file without
   * the renderer changing.
   */
  states: Record<PetState, string>;
};

/**
 * The species this project ships drawings for.
 *
 * Not the species that exist. Anybody can register one on the game contract
 * and its art lives at a url, so this list is only "what the app and the CLI
 * already have on disk" — the question it answers is whether art has to be
 * downloaded, never whether a pet is real.
 */
export const PET_KINDS = ['blackdragon', 'greendragon'] as const;
export type PetKind = (typeof PET_KINDS)[number];

/** Does this project ship the drawings for this species? */
export function isBundledKind(kind: string): kind is PetKind {
  return (PET_KINDS as readonly string[]).includes(kind);
}

export const RARITIES = ['common', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];

/** Phases 1–3 have art; the contract's phase 4 reuses the last drawing. */
export type EvolutionPhase = 1 | 2 | 3 | 4;

/** Frame size petdex renders at. Kept so an atlas can be dropped in. */
export const FRAME = { width: 192, height: 208 } as const;

/** The pet as the game contract's `get_pet` returns it. */
export type ChainPet = {
  pet_id: number;
  owner_id: string;
  name: string;
  category: string;
  rarity: string;
  level: number;
  star: number;
  evolution_phase?: number;
  /** Nanoseconds. An absolute deadline, not a countdown — see `isStarving`. */
  starves_at?: string;
  locked?: boolean;
};

/**
 * The species id a pet carries, as a name safe to use as a folder.
 *
 * This used to coerce anything unrecognised to `blackdragon`, which was
 * right while the contract had exactly two species and is wrong now that
 * anybody can add one: a player's own animal would have installed as
 * somebody else's. The check that remains is the contract's own id rule,
 * because this string becomes a directory under `~/.joygotchi`.
 */
function asKind(category: string): string {
  return /^[a-z0-9]{3,24}$/.test(category) ? category : 'blackdragon';
}

function asRarity(rarity: string): Rarity {
  const lower = rarity.toLowerCase();
  return (RARITIES as readonly string[]).includes(lower) ? (lower as Rarity) : 'common';
}

function asPhase(phase: number | undefined): EvolutionPhase {
  const value = Math.min(4, Math.max(1, Math.trunc(phase ?? 1)));
  return value as EvolutionPhase;
}

/**
 * Art file for a kind and phase.
 *
 * Phase 4 has no drawing of its own, so it shows phase 3. Falling back is
 * better than a broken image, and the contract caps evolution at 4.
 */
export function artPath(kind: string, phase: EvolutionPhase): string {
  return `${kind}/${Math.min(3, phase)}.gif`;
}

/**
 * A slug that is stable for the pet and readable in a path.
 *
 * The id is part of it on purpose: two players may both call their dragon
 * SMAUG, and `~/.joygotchi/pets/smaug/` can only be one of them.
 */
export function petSlug(pet: Pick<ChainPet, 'pet_id' | 'name'>): string {
  const name = pet.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return name ? `${name}-${pet.pet_id}` : `pet-${pet.pet_id}`;
}

/**
 * A species as the game contract's `get_species` returns it.
 *
 * `art` is one absolute url per evolution phase. It is written by whoever
 * registered the species, so it is data from a stranger: an installer uses
 * it to fetch a file and must bound what it accepts, and nothing should put
 * it anywhere it would be read as markup or as a path.
 */
export type ChainSpecies = {
  id: string;
  name: string;
  creator_id: string;
  art: string[];
  minted?: number;
};

/** Build the on-disk package for a pet read off the chain. */
export function toPetPackage(
  pet: ChainPet,
  chain: { network: 'testnet' | 'mainnet'; contract: string }
): PetPackage {
  const kind = asKind(pet.category);
  const phase = asPhase(pet.evolution_phase);
  const art = artPath(kind, phase);

  // Every state resolves, and today they all resolve to the same idle loop.
  const states = Object.fromEntries(PET_STATES.map((state) => [state, art])) as Record<
    PetState,
    string
  >;

  return {
    format: 'joygotchi/1',
    slug: petSlug(pet),
    displayName: pet.name,
    petId: pet.pet_id,
    installCode: encodeInstallCode(pet.pet_id),
    kind,
    rarity: asRarity(pet.rarity),
    level: pet.level,
    star: pet.star,
    evolutionPhase: phase,
    chain: { ...chain, owner: pet.owner_id },
    frame: FRAME,
    spriteVersion: 1,
    states
  };
}

/**
 * Has the pet starved?
 *
 * `starves_at` is a deadline in nanoseconds, not a duration. Reading it as
 * "seconds left" is a mistake this project has already made once, which is
 * why the only place that divides it is here.
 */
export function isStarving(pet: ChainPet, nowMs = Date.now()): boolean {
  const deadline = Number(pet.starves_at ?? 0);
  if (deadline === 0) return false;
  return deadline / 1e6 <= nowMs;
}
