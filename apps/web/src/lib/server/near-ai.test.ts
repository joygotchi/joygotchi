import { describe, expect, it } from 'vitest';
import { mealGrader, petPersona } from './near-ai';
import type { ChainPet } from '@joygotchi/pet';

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

  it('anchors the middle of the range, which is what stops a ceiling answer', () => {
    const prompt = mealGrader(pet(5));

    expect(prompt).toMatch(/between 12 and 20/);
    expect(prompt).toMatch(/above 28/);
    expect(prompt).toMatch(/below 8/);
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
    expect(mealGrader(pet(0, { starves_at: '0' }))).toContain('has eaten recently');
  });

  it('carries the pet’s own numbers, so two pets are not graded identically', () => {
    const prompt = mealGrader(pet(5));

    expect(prompt).toContain('KURO');
    expect(prompt).toContain('Rare');
    expect(prompt).toContain('level 2');
  });
});
