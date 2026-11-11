import { GAME_CONTRACT } from '#lib/config';
import { viewFunction } from '#lib/near/rpc';
import { petSlug, type ChainPet, type ChainSpecies } from '@joygotchi/pet';

/**
 * What a link preview says about a pet, read straight from the contract.
 *
 * Kept apart from `#lib/pets` on purpose: that module pulls in the wallet,
 * which only runs in a browser, and this runs on the server for crawlers.
 */
export type PetPreview = {
  petId: number;
  slug: string;
  name: string;
  rarity: string;
  level: number;
  phase: number;
  species: string;
  art: string;
  forSale: string | null;
};

/** `ancalagon-3` → pet 3, or null when the slug doesn't match its pet. */
export async function petPreview(slug: string): Promise<PetPreview | null> {
  const id = Number(slug.split('-').pop());
  if (!Number.isInteger(id) || id < 1) return null;

  const pet = await viewFunction<ChainPet | null>(GAME_CONTRACT, 'get_pet', { pet_id: id });
  if (!pet || petSlug(pet) !== slug) return null;

  const [species, listing] = await Promise.all([
    viewFunction<ChainSpecies | null>(GAME_CONTRACT, 'get_species', { id: pet.category }).catch(
      () => null
    ),
    viewFunction<{ price: string } | null>(GAME_CONTRACT, 'get_pet_listing', {
      pet_id: id
    }).catch(() => null)
  ]);

  const phase = Math.max(1, Number(pet.evolution_phase ?? 1) || 1);
  const art = species?.art ?? [];
  return {
    petId: id,
    slug,
    name: pet.name,
    rarity: String(pet.rarity),
    level: Number(pet.level ?? 0),
    phase,
    species: species?.name ?? pet.category,
    art: art[Math.min(phase, art.length) - 1] ?? art[0] ?? '',
    forSale: listing ? listing.price : null
  };
}

/** A price in yoctoNEAR as a short NEAR amount: `500000…` → `0.5`. */
export function shortNear(yocto: string): string {
  const whole = BigInt(yocto) / 10n ** 24n;
  const frac = (BigInt(yocto) % 10n ** 24n).toString().padStart(24, '0').slice(0, 2).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Escape text for an HTML attribute. */
export function attr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
