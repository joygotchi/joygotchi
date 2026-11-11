import { describe, expect, it } from 'vitest';
import { artUriError, artUris, speciesIdError } from './species.js';

/*
 * These rules are a copy of the contract's `species_id_error` and
 * `art_uri_error`. The copy earns its keep by refusing before a deposit is
 * attached: registering costs several NEAR, and learning from a panic that
 * you typed a capital letter is an expensive lesson.
 *
 * Which also means the copy has to agree with the original. These cases are
 * the same ones `contracts/game/src/lib.rs` asserts.
 */

describe('speciesIdError', () => {
  it('accepts what the contract accepts', () => {
    expect(speciesIdError('coolbeast')).toBeNull();
    expect(speciesIdError('beast2')).toBeNull();
  });

  it('refuses what the contract refuses', () => {
    expect(speciesIdError('ab')).not.toBeNull();
    expect(speciesIdError('a'.repeat(25))).not.toBeNull();
    expect(speciesIdError('CoolBeast')).not.toBeNull();
    expect(speciesIdError('cool-beast')).not.toBeNull();
    expect(speciesIdError('../../etc')).not.toBeNull();
    expect(speciesIdError('cool beast')).not.toBeNull();
  });
});

describe('artUriError', () => {
  it('accepts what the contract accepts', () => {
    expect(artUriError('https://art.example/x/1.gif')).toBeNull();
  });

  it('refuses what the contract refuses', () => {
    expect(artUriError('http://art.example/x/1.gif')).not.toBeNull();
    expect(artUriError('/assets/animation/x/1.gif')).not.toBeNull();
    expect(artUriError('ipfs://whatever')).not.toBeNull();
    expect(artUriError('https://user:pass@art.example/x.gif')).not.toBeNull();
    expect(artUriError('https://art.example/a b.gif')).not.toBeNull();
    expect(artUriError('')).not.toBeNull();
    expect(artUriError(`https://a.example/${'x'.repeat(300)}`)).not.toBeNull();
  });
});

describe('artUris', () => {
  const palette = { hue: 200, saturation: 130 };

  it('gives one url per phase, all three different', () => {
    const uris = artUris('https://joygotchi.example', 'greendragon', palette);
    expect(uris).toHaveLength(3);
    expect(new Set(uris).size).toBe(3);
  });

  it('builds urls the contract will accept', () => {
    // The creator is the main source of species, so a colourway that
    // produced a url the contract refuses would be a dead form.
    for (const base of ['blackdragon', 'greendragon'] as const) {
      for (const hue of [0, 1, 180, 359]) {
        for (const saturation of [25, 100, 200]) {
          for (const uri of artUris('https://joygotchi.example', base, { hue, saturation })) {
            expect(artUriError(uri)).toBeNull();
          }
        }
      }
    }
  });

  it('carries the colourway, which is the whole recipe', () => {
    const [first] = artUris('https://joygotchi.example', 'blackdragon', palette);
    expect(first).toContain('/api/species/art/blackdragon/1.gif');
    expect(first).toContain('h=200');
    expect(first).toContain('s=130');
  });

  it('stays well inside the length the contract allows', () => {
    // 200 characters, and an origin can be long.
    const long = `https://${'a'.repeat(60)}.vercel.app`;
    for (const uri of artUris(long, 'greendragon', palette)) {
      expect(uri.length).toBeLessThan(200);
    }
  });
});
