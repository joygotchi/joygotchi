import { describe, expect, it } from 'vitest';
import {
  InvalidInstallCodeError,
  MAX_PET_ID,
  decodeInstallCode,
  encodeInstallCode,
  isInstallCode
} from './install-code.js';

describe('install codes', () => {
  it('round trips every id a player will ever see', () => {
    for (const petId of [1, 2, 3, 20, 999, 65_535, 16_777_216, MAX_PET_ID]) {
      expect(decodeInstallCode(encodeInstallCode(petId))).toBe(petId);
    }
  });

  it('gives pet 1 a code as long as pet four billion', () => {
    // A code that changes shape with the id looks broken on a new chain.
    expect(encodeInstallCode(1)).toHaveLength(16);
    expect(encodeInstallCode(MAX_PET_ID)).toHaveLength(16);
    expect(encodeInstallCode(1)).toMatch(/^jg1_[0-9a-hjkmnp-tv-z]{12}$/);
  });

  it('survives the top bit being set, which `<<` would read as negative', () => {
    expect(decodeInstallCode(encodeInstallCode(0xffffffff))).toBe(4_294_967_295);
    expect(decodeInstallCode(encodeInstallCode(0x80000001))).toBe(2_147_483_649);
  });

  it('accepts a code someone retyped from a screenshot', () => {
    const code = encodeInstallCode(42);
    expect(decodeInstallCode(code.toUpperCase())).toBe(42);
    expect(decodeInstallCode(`  ${code}  `)).toBe(42);

    // Crockford: I and L read as 1, O as 0, U as V. Someone copying by eye.
    // Only the body is substituted — the `jg1` prefix is a label, and mangling
    // it is a different mistake.
    const body = code.slice('jg1_'.length).replace(/1/g, 'l').replace(/0/g, 'O');
    expect(decodeInstallCode(`jg1_${body}`)).toBe(42);
  });

  it('works without the prefix, which people drop when pasting', () => {
    const code = encodeInstallCode(7);
    expect(decodeInstallCode(code.slice('jg1_'.length))).toBe(7);
  });

  it('refuses a code with a typo instead of installing the wrong pet', () => {
    const body = encodeInstallCode(1234).slice('jg1_'.length);
    // Swap one character in the middle, where the id lives, for another valid
    // symbol: the length and the alphabet still check out, so only the
    // checksum stands between this and somebody else's pet.
    const swapped = body[6] === 'q' ? 'r' : 'q';
    const broken = `jg1_${body.slice(0, 6)}${swapped}${body.slice(7)}`;

    expect(() => decodeInstallCode(broken)).toThrow(InvalidInstallCodeError);
    expect(() => decodeInstallCode(broken)).toThrow('typo');
    expect(isInstallCode(broken)).toBe(false);
  });

  it('says what is wrong rather than just failing', () => {
    expect(() => decodeInstallCode('jg1_short')).toThrow('12 characters');
    expect(() => decodeInstallCode('jg1_!!!!!!!!!!!!')).toThrow('not part of an install code');
    expect(() => encodeInstallCode(0)).toThrow('not a pet id');
    expect(() => encodeInstallCode(1.5)).toThrow('not a pet id');
  });

  it('asks for a newer CLI rather than blaming the code', () => {
    // The first two characters carry the version byte. A code from a future
    // format should not come back as "typo" — the player cannot fix that.
    const body = encodeInstallCode(5).slice('jg1_'.length);
    const bumped = `jg1_1${body.slice(1)}`;

    expect(() => decodeInstallCode(bumped)).toThrow('update the CLI');
  });

  it('is deterministic, so a page can show the code without asking anyone', () => {
    expect(encodeInstallCode(3)).toBe(encodeInstallCode(3));
    expect(encodeInstallCode(3)).not.toBe(encodeInstallCode(4));
  });
});

describe('codes are told apart at a glance', () => {
  // The first cut encoded the id big-endian and padded, so pet 1, 2 and 3 all
  // read `jg1_0400000…` and only the last characters moved. Side by side on a
  // page they looked like one string, which is how people paste the wrong one.
  it('shares no leading run between neighbouring ids', () => {
    const codes = [1, 2, 3, 4].map((id) => encodeInstallCode(id).slice('jg1_'.length));

    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        const a = codes[i] ?? '';
        const b = codes[j] ?? '';
        let shared = 0;
        while (shared < a.length && a[shared] === b[shared]) shared++;
        expect(shared, `${a} vs ${b} share ${shared} leading characters`).toBeLessThan(3);
      }
    }
  });

  it('still decodes, scattering and all', () => {
    for (const id of [1, 2, 3, 4, 255, 65_536, 4_294_967_295]) {
      expect(decodeInstallCode(encodeInstallCode(id))).toBe(id);
    }
  });

  it('is a permutation: no two ids land on one code', () => {
    const seen = new Map<string, number>();
    for (let id = 1; id <= 3_000; id++) {
      const code = encodeInstallCode(id);
      expect(seen.has(code), `${id} collided with ${seen.get(code)}`).toBe(false);
      seen.set(code, id);
    }
  });
});
