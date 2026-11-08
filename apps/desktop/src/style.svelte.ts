/**
 * What a pet wears, and what it stands in front of.
 *
 * Kept on this machine rather than on chain, deliberately. A hat changes
 * nothing anybody else can verify and nothing anybody can take — putting it
 * in contract storage would mean a Borsh layout change and a migration for
 * every staked record, which is a real cost already paid once today for a
 * feature that needed it. If hats ever become tradeable they move on chain
 * and earn that cost; until then they are a preference, and preferences
 * live where preferences live.
 */
export type Wearable = { id: string; name: string; art: string | null };

/*
 * Hats are not in this file any more.
 *
 * They are NEP-171 tokens on the accessory contract, so what a pet is
 * wearing is a fact about the chain and not a preference on this machine.
 * Backdrops stay here: nobody owns a view of a meadow.
 */

export const BACKDROPS: Wearable[] = [
  { id: 'none', name: 'None', art: null },
  { id: 'meadow', name: 'Meadow', art: '/assets/background/screen_pet.png' },
  { id: 'autumn', name: 'Autumn', art: '/assets/background/bg.png' },
  { id: 'arena', name: 'Arena', art: '/assets/background/battle.png' }
];

export type PetStyle = { backdrop: string };

const DEFAULT: PetStyle = { backdrop: 'meadow' };
const KEY = 'joygotchi:style';

/** Every pet's style, by slug, as one reactive object. */
const styles = $state<Record<string, PetStyle>>(load());

function load(): Record<string, PetStyle> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    // Anything could be in there — an older shape, a half-written value, a
    // person editing it by hand. Take only what type-checks.
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, PetStyle> = {};
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const { backdrop } = value as Partial<PetStyle>;
      out[slug] = {
        backdrop: BACKDROPS.some((b) => b.id === backdrop)
          ? (backdrop as string)
          : DEFAULT.backdrop
      };
    }
    return out;
  } catch {
    return {};
  }
}

export const styleFor = (slug: string): PetStyle => styles[slug] ?? DEFAULT;

export function setStyle(slug: string, patch: Partial<PetStyle>) {
  styles[slug] = { ...styleFor(slug), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(styles));
  } catch {
    // Nothing to do about a full or blocked store, and losing a hat is not
    // worth an error in front of somebody.
  }
}

export const artOf = (list: Wearable[], id: string): string | null =>
  list.find((item) => item.id === id)?.art ?? null;
