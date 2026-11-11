import { describe, expect, it } from 'vitest';
import {
  ATLAS_COLUMNS,
  ATLAS_ROWS,
  ATLAS_STATES,
  RECOMMENDED_SHEET,
  atlasFrom,
  pngSize,
  rowFor,
  rowOffset
} from './atlas.js';
import { PET_STATES } from './states.js';

const sheet = (width: number, height: number) => atlasFrom('spritesheet.png', width, height);

describe('the nine rows', () => {
  it('are petdex\'s nine, in petdex\'s order', () => {
    /*
     * The whole reason to use their grid rather than invent one: a sheet
     * made with their Hatch Pet skill drops in unchanged, and one made here
     * works there. If this list ever reorders, every existing sheet starts
     * playing the wrong animation for every state — silently.
     */
    expect([...ATLAS_STATES]).toEqual([
      'idle',
      'running-right',
      'running-left',
      'waving',
      'jumping',
      'failed',
      'waiting',
      'running',
      'review'
    ]);
  });

  it('is the front of the state vocabulary, not a second copy of it', () => {
    expect([...ATLAS_STATES]).toEqual(PET_STATES.slice(0, ATLAS_ROWS));
  });

  it('has no row for the states a coding agent never causes', () => {
    // `feeding` and `battling` come from the game, so a petdex sheet simply
    // has nothing drawn for them and the renderer falls back to idle.
    expect(rowFor('feeding')).toBeNull();
    expect(rowFor('battling')).toBeNull();
    expect(rowFor('idle')).toBe(0);
    expect(rowFor('review')).toBe(8);
  });
});

describe('atlasFrom', () => {
  it('reads the size the Hatch Pet skill exports', () => {
    const found = sheet(RECOMMENDED_SHEET.width, RECOMMENDED_SHEET.height);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // 1536/8 and 1872/9 — the frame size this package has always declared.
    expect(found.atlas.frame).toEqual({ width: 192, height: 208 });
    expect(found.atlas.columns).toBe(ATLAS_COLUMNS);
    expect(found.atlas.rows).toBe(ATLAS_ROWS);
  });

  it('refuses a sheet whose grid does not divide evenly', () => {
    /*
     * This is the failure worth being strict about. A sheet a few pixels
     * off still renders — every frame simply sits slightly wrong, which
     * reads as bad art rather than a bad file, and nobody reports it.
     */
    const found = sheet(1530, 1872);
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.why).toContain('1536');
  });

  it('refuses something too small to be a sheet at all', () => {
    expect(sheet(128, 128).ok).toBe(false);
  });

  it('refuses a size that is not a size', () => {
    expect(sheet(0, 0).ok).toBe(false);
    expect(sheet(-1536, 1872).ok).toBe(false);
    expect(sheet(1536.5, 1872).ok).toBe(false);
  });

  it('accepts a bigger sheet that still divides', () => {
    const found = sheet(3072, 3744);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.atlas.frame).toEqual({ width: 384, height: 416 });
  });
});

describe('rowOffset', () => {
  it('moves the sheet up by whole frames', () => {
    const found = sheet(RECOMMENDED_SHEET.width, RECOMMENDED_SHEET.height);
    if (!found.ok) throw new Error('fixture');

    expect(rowOffset('idle', found.atlas)).toBe('0px -0px');
    expect(rowOffset('waving', found.atlas)).toBe('0px -624px');
    // A state with no row of its own shows the first one.
    expect(rowOffset('feeding', found.atlas)).toBe('0px -0px');
  });
});

describe('pngSize', () => {
  /** A PNG header with the given dimensions, which is all this reads. */
  const header = (width: number, height: number) => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0, 0, 0, 13], 8);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    const write = (value: number, at: number) => {
      bytes[at] = (value >>> 24) & 0xff;
      bytes[at + 1] = (value >>> 16) & 0xff;
      bytes[at + 2] = (value >>> 8) & 0xff;
      bytes[at + 3] = value & 0xff;
    };
    write(width, 16);
    write(height, 20);
    return bytes;
  };

  it('reads a sheet size without an image library', () => {
    // The CLI is where a creator finds out their sheet is wrong, and it has
    // to work with nothing installed.
    expect(pngSize(header(1536, 1872))).toEqual({ width: 1536, height: 1872 });
  });

  it('reads a size too big for a signed 32-bit read', () => {
    // Not a realistic sheet, but a left-shift here would come back negative
    // and the error message would be nonsense.
    expect(pngSize(header(3_000_000_000, 8))?.width).toBe(3_000_000_000);
  });

  it('says no to anything that is not a PNG', () => {
    expect(pngSize(new Uint8Array(8))).toBeNull();
    expect(pngSize(new Uint8Array([71, 73, 70, 56, 57, 97]))).toBeNull();
    // Right signature, wrong first chunk.
    const wrong = header(1536, 1872);
    wrong.set([0x66, 0x4f, 0x4f, 0x66], 12);
    expect(pngSize(wrong)).toBeNull();
  });
});
