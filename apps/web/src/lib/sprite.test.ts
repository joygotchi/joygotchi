import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  globalColorTable,
  paletteQuery,
  readPalette,
  recolour,
  type Palette
} from './sprite.js';

const base = new Uint8Array(
  readFileSync(new URL('../../static/assets/animation/greendragon/3.gif', import.meta.url))
);

const shifted: Palette = { hue: 120, saturation: 100 };

describe('globalColorTable', () => {
  it('finds the palette in the art this game ships', () => {
    const table = globalColorTable(base);
    expect(table).not.toBeNull();
    // 16 colours is what every one of these drawings uses.
    expect(table!.end - table!.start).toBe(48);
  });

  it('says no rather than guessing at something that is not a GIF', () => {
    expect(globalColorTable(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(globalColorTable(new Uint8Array(20))).toBeNull();
  });
});

describe('recolour', () => {
  it('changes the palette and nothing else', () => {
    /*
     * The whole trick. Frames reference the colour table by index, so
     * rewriting 48 bytes leaves the animation, the frame delays and the
     * transparent index exactly as they were — and the file the same size.
     */
    const out = recolour(base, shifted);
    const table = globalColorTable(base)!;

    expect(out.length).toBe(base.length);
    expect(out.slice(0, table.start)).toEqual(base.slice(0, table.start));
    expect(out.slice(table.end)).toEqual(base.slice(table.end));
    expect(out.slice(table.start, table.end)).not.toEqual(base.slice(table.start, table.end));
  });

  it('keeps every colour as light as it was', () => {
    // A pixel sprite's depth is in its light and dark. Rotating that away
    // turns a dragon into a silhouette.
    const out = recolour(base, shifted);
    const { start, end } = globalColorTable(base)!;
    const lightness = (a: Uint8Array, i: number) =>
      (Math.max(a[i]!, a[i + 1]!, a[i + 2]!) + Math.min(a[i]!, a[i + 1]!, a[i + 2]!)) / 2;

    for (let i = start; i < end; i += 3) {
      expect(Math.abs(lightness(out, i) - lightness(base, i))).toBeLessThanOrEqual(1);
    }
  });

  it('is a no-op for the colourway the art is already in', () => {
    expect(recolour(base, { hue: 0, saturation: 100 })).toBe(base);
  });

  it('gives a different drawing for each hue', () => {
    const seen = new Set(
      [0, 60, 120, 180, 240, 300].map((hue) =>
        recolour(base, { hue, saturation: 100 }).slice(13, 61).join(',')
      )
    );
    expect(seen.size).toBe(6);
  });

  it('hands back something that is not a GIF unchanged', () => {
    // Better a pet in the wrong colour than a corrupted file.
    const junk = new Uint8Array([1, 2, 3, 4]);
    expect(recolour(junk, shifted)).toBe(junk);
  });
});

describe('readPalette', () => {
  it('wraps a hue instead of refusing it', () => {
    expect(readPalette(new URLSearchParams('h=400&s=100')).hue).toBe(40);
    expect(readPalette(new URLSearchParams('h=-30&s=100')).hue).toBe(330);
  });

  it('clamps saturation into what still looks like a pet', () => {
    expect(readPalette(new URLSearchParams('s=9999')).saturation).toBe(200);
    expect(readPalette(new URLSearchParams('s=0')).saturation).toBe(25);
  });

  it('falls back rather than producing NaN from a hand-edited url', () => {
    expect(readPalette(new URLSearchParams('h=abc&s=def'))).toEqual({
      hue: 0,
      saturation: 100
    });
    expect(readPalette(new URLSearchParams())).toEqual({ hue: 0, saturation: 100 });
  });

  it('round trips through a query string', () => {
    const palette = { hue: 212, saturation: 140 };
    expect(readPalette(new URLSearchParams(paletteQuery(palette)))).toEqual(palette);
  });
});
