import { PET_STATES, type PetState } from './states.js';

/**
 * A sprite atlas: one row per state, frames left to right.
 *
 * This is petdex's format, deliberately unchanged. A pet made with their
 * Hatch Pet skill is a 1536×1872 PNG — eight frames across, nine states
 * down, 192×208 a frame — and `PET_STATES` has carried those nine rows in
 * their order since before anything here could read one. Adopting the
 * format rather than inventing one means their gallery is a source of pets
 * and ours is a destination for them.
 *
 * The alternative this replaces is one idle GIF per evolution phase with
 * CSS motion over it. That is honest movement but it is not animation: a
 * pet cannot *wave*, it can only tilt while holding still.
 */

/** Frames across, states down. */
export const ATLAS_COLUMNS = 8;
export const ATLAS_ROWS = 9;

/** petdex refuses anything smaller, and so do we. */
export const MIN_SHEET_PX = 256;

/** The size the Hatch Pet skill and ChatGPT both export. */
export const RECOMMENDED_SHEET = { width: 1536, height: 1872 } as const;

/**
 * The nine rows, in the order they appear top to bottom.
 *
 * `PET_STATES` holds these nine first and then two of our own — `feeding`
 * and `battling` come from the game rather than from a coding agent, so a
 * petdex sheet has no row for them and the renderer falls back to idle.
 * Slicing rather than re-listing is what keeps the two from drifting.
 */
export const ATLAS_STATES = PET_STATES.slice(0, ATLAS_ROWS) as readonly PetState[];

export type Atlas = {
  /** File name inside the pet's folder. */
  sheet: string;
  columns: number;
  rows: number;
  frame: { width: number; height: number };
};

/** Which row this state is drawn on, or null if the sheet has none. */
export function rowFor(state: PetState): number | null {
  const row = ATLAS_STATES.indexOf(state);
  return row === -1 ? null : row;
}

/**
 * Where a state's animation starts on the sheet, as a CSS `background-position`.
 *
 * Negative pixels, because a sprite sheet is shown by moving the image behind
 * a window the size of one frame.
 */
export function rowOffset(state: PetState, atlas: Atlas): string {
  const row = rowFor(state) ?? 0;
  return `0px -${row * atlas.frame.height}px`;
}

/**
 * Read an atlas out of a sheet's dimensions, or say why it cannot be one.
 *
 * The grid is fixed rather than measured: eight by nine is what the format
 * is, and a sheet that does not divide evenly would be rendered with every
 * frame a few pixels off — which looks like bad art rather than like a bad
 * file, and is the kind of thing nobody reports as a bug.
 */
export function atlasFrom(
  sheet: string,
  width: number,
  height: number
): { ok: true; atlas: Atlas } | { ok: false; why: string } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, why: 'That file does not look like an image' };
  }
  if (width < MIN_SHEET_PX || height < MIN_SHEET_PX) {
    return {
      ok: false,
      why: `A sheet is at least ${MIN_SHEET_PX}×${MIN_SHEET_PX}; this is ${width}×${height}`
    };
  }
  if (width % ATLAS_COLUMNS !== 0 || height % ATLAS_ROWS !== 0) {
    return {
      ok: false,
      why:
        `A sheet is ${ATLAS_COLUMNS} frames across and ${ATLAS_ROWS} states down, so its ` +
        `width must divide by ${ATLAS_COLUMNS} and its height by ${ATLAS_ROWS}. ` +
        `${width}×${height} does not. The usual size is ` +
        `${RECOMMENDED_SHEET.width}×${RECOMMENDED_SHEET.height}.`
    };
  }

  return {
    ok: true,
    atlas: {
      sheet,
      columns: ATLAS_COLUMNS,
      rows: ATLAS_ROWS,
      frame: { width: width / ATLAS_COLUMNS, height: height / ATLAS_ROWS }
    }
  };
}

/**
 * Read a PNG's size from its header.
 *
 * Eight bytes of signature, then the IHDR chunk whose first eight bytes of
 * data are the dimensions, big-endian. Enough to validate a sheet without
 * an image library in the CLI — and the CLI is where a creator finds out,
 * so it has to work with nothing installed.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  if (SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;

  const read = (at: number) =>
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  return { width: read(16), height: read(20) };
}
