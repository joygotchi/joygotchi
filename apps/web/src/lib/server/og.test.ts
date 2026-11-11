import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OG_HEIGHT, OG_WIDTH, fontSafe, renderCard, spriteFor, textWidth } from './og';
import { attr, shortNear } from './preview';

describe('the pixel font', () => {
  it('upper-cases and blanks what it cannot draw', () => {
    expect(fontSafe('Kuro #6 · lv2')).toBe('KURO #6 · LV2');
    expect(fontSafe('ドラゴン!')).toBe('     ');
  });

  it('measures six pixels a character, less the trailing gap', () => {
    expect(textWidth('AB', 1)).toBe(11);
    expect(textWidth('AB', 10)).toBe(110);
    expect(textWidth('', 10)).toBe(0);
  });
});

describe('preview text', () => {
  it('shortens a yoctoNEAR price', () => {
    expect(shortNear('500000000000000000000000')).toBe('0.5');
    expect(shortNear('2000000000000000000000000')).toBe('2');
    expect(shortNear('1250000000000000000000000')).toBe('1.25');
  });

  it('escapes a pet name for an attribute', () => {
    // Names are written by whoever minted the pet and land in the page head.
    expect(attr('"><script>')).toBe('&quot;&gt;&lt;script&gt;');
  });
});

describe('the card', () => {
  it('is a 1200×630 PNG, with or without a sprite', async () => {
    const png = await renderCard({ kicker: 'K', title: 'TITLE', lines: ['A', 'B'], sprite: null });
    const meta = await sharp(png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', OG_WIDTH, OG_HEIGHT]);
  });
});

describe('the sprite', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('takes only the first cell of an 8×9 atlas', async () => {
    // A sheet whose first cell is a 192×208 red block and the rest is blank:
    // if the whole sheet were used, the trimmed result would not be that block.
    const cell = await sharp({
      create: { width: 192, height: 208, channels: 4, background: '#ff0000' }
    })
      .png()
      .toBuffer();
    const sheet = await sharp({
      create: { width: 1536, height: 1872, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .composite([{ input: cell, left: 0, top: 0 }])
      .png()
      .toBuffer();
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(sheet)));

    const sprite = await spriteFor('https://art.example/wyvern/1.png', 416);
    const meta = await sharp(sprite!).metadata();
    expect([meta.width, meta.height]).toEqual([384, 416]);
  });

  it('draws the card without a sprite when the art cannot be fetched', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    expect(await spriteFor('https://art.example/missing.png', 440)).toBeNull();
  });
});
