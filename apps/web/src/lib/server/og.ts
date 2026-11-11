import sharp from 'sharp';
import { atlasFrom } from '@joygotchi/pet';

/**
 * Link-preview cards, 1200×630, drawn on the server.
 *
 * Telegram, X and Discord read `og:image` without running any JavaScript and
 * won't take an SVG, so this has to be a PNG made here. Text is drawn as
 * rectangles from a 5×7 pixel font rather than set in a typeface: a serverless
 * function has no system fonts to render with, and the game is pixel art
 * anyway.
 */

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const INK = '#0b0d10';
const GRID = '#151920';
const PANEL = '#12151a';
const TEXT = '#e7ebf0';
const MUTED = '#8b95a3';
export const ACCENT = '#b6f36b';

// ── Pixel font ───────────────────────────────────────────────────────────────

/* prettier-ignore */
const GLYPHS: Record<string, string[]> = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01110','10001','10000','10000','10000','10001','01110'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01110','10001','10000','10111','10001','10001','01111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['01110','00100','00100','00100','00100','00100','01110'],
  J: ['00111','00010','00010','00010','00010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','10001','11001','10101','10011','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11111','00010','00100','00010','00001','10001','01110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  '#': ['01010','01010','11111','01010','11111','01010','01010'],
  '.': ['00000','00000','00000','00000','00000','01100','01100'],
  '·': ['00000','00000','00000','01100','01100','00000','00000'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  ':': ['00000','01100','01100','00000','01100','01100','00000'],
  '/': ['00001','00010','00010','00100','01000','01000','10000'],
  '★': ['00100','00100','11111','01110','01110','11011','10001']
};

/** Characters the font can't draw become a space rather than a gap in the rect run. */
export function fontSafe(text: string): string {
  return [...text.toUpperCase()].map((ch) => (GLYPHS[ch] ? ch : ' ')).join('');
}

/** Width in pixels of `text` at `scale` (each font pixel is `scale` px). */
export function textWidth(text: string, scale: number): number {
  const chars = [...fontSafe(text)].length;
  return chars === 0 ? 0 : (chars * 6 - 1) * scale;
}

function textRects(text: string, x: number, y: number, scale: number, fill: string): string {
  let out = '';
  let cursor = x;
  for (const ch of fontSafe(text)) {
    const rows = GLYPHS[ch]!;
    rows.forEach((row, r) => {
      for (let c = 0; c < 5; c++) {
        if (row[c] === '1') {
          out += `<rect x="${cursor + c * scale}" y="${y + r * scale}" width="${scale}" height="${scale}"/>`;
        }
      }
    });
    cursor += 6 * scale;
  }
  return `<g fill="${fill}">${out}</g>`;
}

/** The largest scale at which `text` fits in `width`, capped at `max`. */
function fitScale(text: string, width: number, max: number): number {
  for (let scale = max; scale > 2; scale--) {
    if (textWidth(text, scale) <= width) return scale;
  }
  return 2;
}

// ── Sprite ───────────────────────────────────────────────────────────────────

/**
 * The pet's first drawing, as a PNG scaled to fit `box` with hard pixels.
 *
 * Art is a GIF (the built-in dragons and their recolours) or a sprite atlas
 * PNG; for an atlas only the first cell — idle, frame one — is the pet.
 * Returns null when the art can't be fetched or read, and the card is drawn
 * without it rather than failing the preview.
 */
export async function spriteFor(url: string, box: number): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());

    let image = sharp(bytes, { animated: false });
    const meta = await image.metadata();
    const atlas = atlasFrom(url, meta.width ?? 0, meta.height ?? 0);
    if (atlas.ok) {
      image = sharp(bytes).extract({
        left: 0,
        top: 0,
        width: atlas.atlas.frame.width,
        height: atlas.atlas.frame.height
      });
    }

    const trimmed = await image.png().toBuffer().then((png) => sharp(png).trim().png().toBuffer());
    const { width = 1, height = 1 } = await sharp(trimmed).metadata();
    const factor = Math.max(1, Math.floor(box / Math.max(width, height)));
    return await sharp(trimmed)
      .resize(width * factor, height * factor, { kernel: 'nearest' })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

// ── Card ─────────────────────────────────────────────────────────────────────

export type Card = {
  /** Small line above the title, in the accent colour. */
  kicker: string;
  title: string;
  /** Up to three short lines under the title. */
  lines: string[];
  sprite: Buffer | null;
};

export async function renderCard(card: Card): Promise<Buffer> {
  const SPRITE_BOX = 440;
  const LEFT = 60;
  const STAGE = 520; // the square the sprite sits in
  const TEXT_X = LEFT + STAGE + 60;
  const TEXT_W = OG_WIDTH - TEXT_X - 60;

  let grid = '';
  for (let x = 0; x <= OG_WIDTH; x += 40) grid += `<rect x="${x}" y="0" width="1" height="${OG_HEIGHT}"/>`;
  for (let y = 0; y <= OG_HEIGHT; y += 40) grid += `<rect x="0" y="${y}" width="${OG_WIDTH}" height="1"/>`;

  const titleScale = fitScale(card.title, TEXT_W, 14);
  const titleY = 230;
  let body = textRects(card.kicker, TEXT_X, 150, fitScale(card.kicker, TEXT_W, 5), ACCENT);
  body += textRects(card.title, TEXT_X, titleY, titleScale, TEXT);
  // One size for every line, the largest at which the longest still fits:
  // lines that each shrink to fit look like a ransom note.
  const lines = card.lines.slice(0, 3);
  const lineScale = Math.min(...lines.map((line) => fitScale(line, TEXT_W, 6)), 6);
  let y = titleY + titleScale * 7 + 50;
  for (const line of lines) {
    body += textRects(line, TEXT_X, y, lineScale, MUTED);
    y += lineScale * 7 + 24;
  }
  body += textRects('JOYGOTCHI.VERCEL.APP', TEXT_X, OG_HEIGHT - 80, 4, MUTED);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}">
    <rect width="100%" height="100%" fill="${INK}"/>
    <g fill="${GRID}">${grid}</g>
    <rect x="${LEFT}" y="${(OG_HEIGHT - STAGE) / 2}" width="${STAGE}" height="${STAGE}" fill="${PANEL}" stroke="#242a33" stroke-width="2"/>
    <rect x="0" y="${OG_HEIGHT - 8}" width="${OG_WIDTH}" height="8" fill="${ACCENT}"/>
    ${body}
  </svg>`;

  const layers: sharp.OverlayOptions[] = [];
  if (card.sprite) {
    const { width = SPRITE_BOX, height = SPRITE_BOX } = await sharp(card.sprite).metadata();
    layers.push({
      input: card.sprite,
      left: Math.round(LEFT + (STAGE - width) / 2),
      top: Math.round((OG_HEIGHT - height) / 2)
    });
  }

  return sharp(Buffer.from(svg)).composite(layers).png().toBuffer();
}
