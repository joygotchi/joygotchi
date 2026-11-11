import type { GalleryPet } from '#lib/pets';

/**
 * What the gallery shows, given what the visitor asked for.
 *
 * Pure, so the rules are tested without a chain: the page reads every pet
 * once and this narrows and orders them as the visitor types and clicks.
 */

export type Sort = 'newest' | 'level' | 'rarity' | 'price';

export const SORTS: [Sort, string][] = [
  ['newest', 'Newest'],
  ['level', 'Level'],
  ['rarity', 'Rarity'],
  ['price', 'Cheapest']
];

const RARITY: Record<string, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };
const rarityRank = (pet: GalleryPet) => RARITY[String(pet.rarity).toLowerCase()] ?? 0;
const price = (pet: GalleryPet) => (pet.listing ? BigInt(pet.listing.price) : null);

export type View = {
  /** `all`, `sale`, or a species id. */
  filter: string;
  /** Matches a name or a pet number; `#6` and `6` both find pet 6. */
  query: string;
  sort: Sort;
};

export function arrange(pets: GalleryPet[], view: View): GalleryPet[] {
  const query = view.query.trim().toLowerCase().replace(/^#/, '');
  let shown = pets.filter((pet) => {
    if (view.filter === 'sale' && !pet.listing) return false;
    if (view.filter !== 'all' && view.filter !== 'sale' && pet.kind !== view.filter) return false;
    if (!query) return true;
    return pet.name.toLowerCase().includes(query) || String(pet.pet_id) === query;
  });

  const newest = (a: GalleryPet, b: GalleryPet) => Number(b.pet_id) - Number(a.pet_id);
  shown = [...shown].sort((a, b) => {
    switch (view.sort) {
      case 'level':
        return Number(b.level) - Number(a.level) || newest(a, b);
      case 'rarity':
        return rarityRank(b) - rarityRank(a) || newest(a, b);
      case 'price': {
        // Pets for sale first, cheapest first; the rest after, newest first.
        const pa = price(a);
        const pb = price(b);
        if (pa !== null && pb !== null) return pa < pb ? -1 : pa > pb ? 1 : newest(a, b);
        if (pa !== null) return -1;
        if (pb !== null) return 1;
        return newest(a, b);
      }
      default:
        return newest(a, b);
    }
  });
  return shown;
}

/** How many the gallery draws at a time. */
export const PAGE_SIZE = 20;
