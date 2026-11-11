import { BASE_PHASES, paletteQuery, type BaseKind, type Palette } from '#lib/sprite';

/**
 * The rules the game contract enforces on a species, repeated here.
 *
 * Deliberately a copy, not a shortcut. The contract is the authority and
 * checks all of this again; what this buys is that a refused species costs
 * nothing, because the deposit is only attached to a call these same rules
 * say will pass. Registering costs several NEAR, and finding out from a
 * panic is an expensive way to learn you typed a capital letter.
 *
 * Kept beside `contracts/game/src/types.rs` — `species_id_error` and
 * `art_uri_error` are the originals.
 */

export const MIN_SPECIES_ID = 3;
export const MAX_SPECIES_ID = 24;
export const MAX_SPECIES_NAME = 32;
export const MAX_ART_URI = 200;

/** Why this id would be refused, or null. */
export function speciesIdError(id: string): string | null {
  if (id.length < MIN_SPECIES_ID || id.length > MAX_SPECIES_ID) {
    return `An id is ${MIN_SPECIES_ID} to ${MAX_SPECIES_ID} characters`;
  }
  if (!/^[a-z0-9]+$/.test(id)) return 'Lowercase letters and digits only';
  return null;
}

/** Why this art url would be refused, or null. */
export function artUriError(uri: string): string | null {
  if (uri === '' || uri.length > MAX_ART_URI) {
    return `A url is 1 to ${MAX_ART_URI} characters`;
  }
  if (!uri.startsWith('https://')) return 'A url must start with https://';
  const host = uri.slice('https://'.length).split('/')[0] ?? '';
  if (host === '' || host.includes('@')) return 'A url must not carry credentials';
  if (/\s/.test(uri)) return 'A url must not contain whitespace';
  return null;
}

/**
 * The three urls a species built in this creator is registered with.
 *
 * They point back at this app, which is the whole reason the creator needs
 * no uploads: the art is a recolour of a drawing already in this repository,
 * so what goes on chain is a recipe and there is no file for anyone to keep
 * alive. `origin` is passed in rather than read from `location` so this can
 * be tested, and so a preview deployment never registers a species whose
 * art only exists on that preview.
 */
export function artUris(origin: string, base: BaseKind, palette: Palette): string[] {
  const query = paletteQuery(palette);
  return BASE_PHASES.map(
    (phase) => `${origin}/api/species/art/${base}/${phase}.gif?${query}`
  );
}
