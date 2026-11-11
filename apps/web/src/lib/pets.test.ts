import { describe, expect, it } from 'vitest';
import { artFor, type GalleryPet } from './pets.js';

/*
 * `artFor` is a copy of the contract's `Species::art_for`
 * (`contracts/game/src/types.rs`). A wallet shows what the contract picks and
 * the page shows what this picks, so the two must agree on every phase.
 */

const ART = ['https://x/1.png', 'https://x/2.png', 'https://x/3.png'];
const pet = (art: string[], evolution_phase?: number) =>
  ({ art, evolution_phase }) as unknown as GalleryPet;

describe('artFor', () => {
  it('picks the drawing for the pet’s own phase', () => {
    expect(artFor(pet(ART, 1))).toBe(ART[0]);
    expect(artFor(pet(ART, 2))).toBe(ART[1]);
    expect(artFor(pet(ART, 3))).toBe(ART[2]);
  });

  it('falls back to the last drawing past the end, as phase 4 does', () => {
    expect(artFor(pet(ART, 4))).toBe(ART[2]);
    expect(artFor(pet(ART.slice(0, 1), 3))).toBe(ART[0]);
  });

  it('treats a missing or zero phase as phase 1', () => {
    expect(artFor(pet(ART))).toBe(ART[0]);
    expect(artFor(pet(ART, 0))).toBe(ART[0]);
  });

  it('takes an explicit phase over the pet’s own', () => {
    expect(artFor(pet(ART, 1), 3)).toBe(ART[2]);
  });

  it('draws nothing for a species the registry does not know', () => {
    expect(artFor(pet([], 2))).toBe('');
  });
});
