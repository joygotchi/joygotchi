/**
 * Recolour a pixel sprite by rewriting its palette.
 *
 * Every drawing this game ships is a GIF with a 16-entry global colour
 * table, and the frames reference it by index. So a new colourway is 48
 * bytes: transform the table, leave the rest of the file alone, and the
 * animation, the frame delays and the transparent index all survive
 * untouched. No decoder, no encoder, no image library, and the output is
 * the same size as the input.
 *
 * This is what makes a pet creator possible without anywhere to upload to.
 * A species' art is a url, the url is this endpoint, and the thing being
 * stored on chain is a recipe rather than a file.
 */

/**
 * The drawings a species can be built on.
 *
 * A creator picks one of these and a colourway; what goes on chain is that
 * choice, as a url. Adding a base here adds it to the creator, and every
 * species already built on the others keeps working.
 */
export const BASE_KINDS = ['blackdragon', 'greendragon'] as const;
export type BaseKind = (typeof BASE_KINDS)[number];

/** Phases a base is drawn for. The contract's fourth reuses the third. */
export const BASE_PHASES = [1, 2, 3] as const;

/** A colourway: how far round the wheel, and how much more saturated. */
export type Palette = {
  /** Degrees, 0–359. */
  hue: number;
  /** Percent, 25–200. 100 leaves saturation alone. */
  saturation: number;
};

export const DEFAULT_PALETTE: Palette = { hue: 0, saturation: 100 };

/**
 * Clamp whatever arrived in a query string into a palette.
 *
 * A missing parameter means the default, not zero. `Number(null)` is 0,
 * which clamped to the saturation floor and turned every url that left `s`
 * out into a washed-out pet.
 */
export function readPalette(params: URLSearchParams): Palette {
  const read = (key: string, fallback: number) => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.trunc(value) : fallback;
  };

  return {
    hue: ((read('h', 0) % 360) + 360) % 360,
    saturation: Math.min(200, Math.max(25, read('s', 100)))
  };
}

/** The query string for a palette, for building an art url. */
export function paletteQuery(palette: Palette): string {
  return `h=${palette.hue}&s=${palette.saturation}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hueToRgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

/**
 * Where a GIF's global colour table starts and how long it is, or null if
 * the file has no global table to rewrite.
 *
 * Header: 6 bytes signature, 4 bytes canvas size, then a packed byte whose
 * top bit says a global table follows and whose bottom three bits give its
 * size, then background index and pixel aspect ratio.
 */
export function globalColorTable(gif: Uint8Array): { start: number; end: number } | null {
  if (gif.length < 13) return null;
  const signature = String.fromCharCode(...gif.slice(0, 3));
  if (signature !== 'GIF') return null;
  const packed = gif[10]!;
  if ((packed & 0x80) === 0) return null;
  const entries = 2 ** ((packed & 0x07) + 1);
  const start = 13;
  const end = start + entries * 3;
  return end <= gif.length ? { start, end } : null;
}

/**
 * The same GIF in a different colourway.
 *
 * Lightness is left exactly as it was, which is what keeps the shading
 * readable: a pixel sprite's depth is in its light and dark, and rotating
 * that away turns a dragon into a silhouette.
 *
 * A GIF with no global colour table comes back unchanged rather than
 * corrupted — better a pet in the wrong colour than a broken image.
 */
export function recolour(gif: Uint8Array, palette: Palette): Uint8Array {
  const table = globalColorTable(gif);
  if (!table) return gif;
  if (palette.hue === 0 && palette.saturation === 100) return gif;

  const out = new Uint8Array(gif);
  const shift = palette.hue / 360;
  const scale = palette.saturation / 100;

  for (let i = table.start; i < table.end; i += 3) {
    const [h, s, l] = rgbToHsl(out[i]! / 255, out[i + 1]! / 255, out[i + 2]! / 255);
    const [r, g, b] = hslToRgb((h + shift) % 1, Math.min(1, s * scale), l);
    out[i] = Math.round(r * 255);
    out[i + 1] = Math.round(g * 255);
    out[i + 2] = Math.round(b * 255);
  }
  return out;
}
