import { describe, expect, it } from 'vitest';
import { mealGrader, petPersona } from './near-ai';
import { MAX_FEED_XP, MIN_FEED_XP, type ChainPet } from '@joygotchi/pet';

const HOUR = 3_600 * 1e9;

/** A pet with a starvation deadline `hours` from now. */
const pet = (hours: number, over: Partial<ChainPet> = {}): ChainPet =>
  ({
    pet_id: 6,
    name: 'KURO',
    rarity: 'Rare',
    category: 'cat',
    level: 2,
    star: 1,
    owner_id: 'kurodenjiro2.testnet',
    starves_at: String(Math.round(Date.now() * 1e6 + hours * HOUR)),
    ...over
  }) as ChainPet;

describe('mealGrader', () => {
  /*
   * The bug this locks down: grading ran through `petPersona`, so the thing
   * being asked was the pet — told in that same prompt that it likes its
   * owner and shows it. Twenty-four samples came back 36 out of 36, every
   * time. These assertions are about who is being asked, not about wording.
   */
  it('does not ask the pet, and does not flatter the owner', () => {
    const prompt = mealGrader(pet(5));

    expect(prompt).not.toContain('You are KURO');
    expect(prompt).toContain('You are not the pet');
    expect(petPersona(pet(5), { viewerIsOwner: true })).toContain('you show it');
    expect(prompt).not.toContain('you show it');
  });

  it('gives three bands, which is what stops a ceiling answer', () => {
    const prompt = mealGrader(pet(5));

    expect(prompt).toContain(`well fed ${MIN_FEED_XP} to 16`);
    expect(prompt).toContain('peckish 18 to 24');
    expect(prompt).toContain(`famished or starved 26 to ${MAX_FEED_XP / 2}`);
  });

  /*
   * The bands cannot ask for a number `xpFrom` would have to correct. A model
   * whose answer was silently clamped on every call would hide the fact that
   * grading had stopped working.
   */
  it('never asks for a number outside what the code allows', () => {
    const numbers = (mealGrader(pet(5)).match(/\b\d+\b/g) ?? [])
      .map(Number)
      // The pet's own level and star count are in there too.
      .filter((n) => n >= MIN_FEED_XP);

    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) expect(n).toBeLessThanOrEqual(MAX_FEED_XP / 2);
  });

  /*
   * Matching a band is the grader's only instruction, so a hunger line that
   * uses words no band contains leaves the model to invent a number.
   */
  it('describes every hunger state in words a band uses', () => {
    const bands = ['well fed', 'peckish', 'famished or starved'];
    const matches = (prompt: string) =>
      bands.some((band) => band.split(' or ').some((word) => prompt.includes(word)));

    for (const hours of [-1, 0.5, 3, 48]) {
      expect(matches(mealGrader(pet(hours))), `${hours}h`).toBe(true);
    }
    expect(matches(mealGrader(pet(0, { starves_at: '0' })))).toBe(true);
  });

  it('states the hunger as a fact about the pet, not as a role', () => {
    expect(mealGrader(pet(-1))).toContain('It has starved');
    expect(mealGrader(pet(0.5))).toContain('It is famished');
    expect(mealGrader(pet(3))).toContain('It is getting peckish');
    expect(mealGrader(pet(48))).toContain('It is well fed');

    // The pet's own voice still speaks in the first person.
    expect(petPersona(pet(-1), { viewerIsOwner: true })).toContain('You have starved');
  });

  it('treats a pet with no deadline as recently fed rather than starved', () => {
    expect(mealGrader(pet(0, { starves_at: '0' }))).toContain('well fed');
  });

  it('carries the pet’s own numbers, so two pets are not graded identically', () => {
    const prompt = mealGrader(pet(5));

    expect(prompt).toContain('KURO');
    expect(prompt).toContain('Rare');
    expect(prompt).toContain('level 2');
  });
});
