import { describe, expect, it } from 'vitest';
import {
  ATLAS_COLUMNS,
  atlasStyle,
  atlasStyleAttr,
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

describe('atlasStyle', () => {
  const atlas = {
    sheet: '1.png',
    columns: 8,
    rows: 9,
    frame: { width: 192, height: 208 }
  };

  it('draws one frame and scales the whole sheet with it', () => {
    // The pet is 98px wide in the window; a frame is 192. Everything —
    // the sheet, the row offset, the step distance — has to move by the
    // same factor or the rows stop landing on whole frames.
    const style = atlasStyle('idle', atlas, '/sheet.png', 0.5);
    expect(style.width).toBe('96px');
    expect(style.height).toBe('104px');
    expect(style['background-size']).toBe('768px 936px');
  });

  it('picks the row for the state', () => {
    const waving = atlasStyle('waving', atlas, '/sheet.png', 1);
    expect(waving['background-position']).toBe('0px -624px');
    expect(atlasStyle('idle', atlas, '/sheet.png', 1)['background-position']).toBe('0px -0px');
  });

  it('falls back to the first row for a state the sheet has no row for', () => {
    // `feeding` and `battling` come from the game, so a petdex sheet has
    // nothing for them. The idle row plus the app's own CSS motion is the
    // honest answer; a blank frame is not.
    expect(atlasStyle('feeding', atlas, '/s.png', 1)['background-position']).toBe('0px -0px');
  });

  it('steps rather than slides', () => {
    // Without steps() the sheet glides and two frames show at once for the
    // whole cycle, which looks like a rendering bug rather than animation.
    expect(atlasStyle('idle', atlas, '/s.png', 1).animation).toContain('steps(8)');
  });

  it('walks exactly one row and lands back where it started', () => {
    const style = atlasStyle('idle', atlas, '/s.png', 0.5);
    // Eight frames at 96px: the span equals the scaled sheet width, so the
    // last step shows frame 8 and the loop returns to frame 1.
    expect(style['--jg-atlas-span']).toBe('768px');
    expect(style['--jg-atlas-span']).toBe(style['background-size']!.split(' ')[0]);
  });

  it('serialises to something a style attribute accepts', () => {
    const attr = atlasStyleAttr('waving', atlas, '/s.png', 0.5);
    expect(attr).toContain('--jg-atlas-span:768px');
    expect(attr).toContain('image-rendering:pixelated');
    expect(attr.split(';').every((pair) => pair.includes(':'))).toBe(true);
  });
});

describe('atlasStyleAttr in an actual attribute', () => {
  const atlas = {
    sheet: '1.png',
    columns: 8,
    rows: 9,
    frame: { width: 192, height: 208 }
  };

  it('survives being put in a double-quoted style attribute', () => {
    /*
     * This is what the first version got wrong, and no value-checking test
     * caught it: `url("sheet.png")` ends a `style="..."` attribute at its
     * first inner quote, so the browser kept the width and dropped every
     * declaration after it. Every sprite rendered as an empty box.
     */
    const attr = atlasStyleAttr('idle', atlas, '/pets/wyvern/spritesheet.png', 0.5);
    expect(attr).not.toContain('"');
    expect(attr).toContain("url('/pets/wyvern/spritesheet.png')");
  });

  it('escapes a quote in the path rather than letting it end the string', () => {
    // A src arrives as a file path or a url. A quote in one would close the
    // CSS string and let whatever follows be read as more declarations.
    const attr = atlasStyleAttr('idle', atlas, "/pets/it's/sheet.png", 1);
    expect(attr).toContain("\\'");
    const url = attr.split('background-image:')[1]!.split(';')[0]!;
    // Exactly two unescaped quotes: the ones this helper wrote.
    expect(url.replace(/\\'/g, '').split("'")).toHaveLength(3);
  });

  it('escapes a backslash, so a Windows path cannot escape the escaping', () => {
    const attr = atlasStyleAttr('idle', atlas, 'C:\\pets\\sheet.png', 1);
    expect(attr).toContain('C:\\\\pets\\\\sheet.png');
  });
});
