import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Two buttons feed a pet: the panel's tile and the name plate's beef icon.
 * For a while only one of them asked for the XP, so which button you happened
 * to press decided whether the meal counted — and the one that earned nothing
 * was the one always on screen. No error appeared anywhere, because nothing
 * had gone wrong; a step was simply missing.
 *
 * So `feedPet` is for `feedAndGrade` to call, and nobody else.
 */
const source = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');

describe('feeding always asks for the XP', () => {
  it('is reached through feedAndGrade, never feedPet directly', () => {
    const callers = ['App.svelte', 'PetPanel.svelte'];

    for (const name of callers) {
      const text = source(name);
      expect(text, `${name} calls feedPet directly`).not.toMatch(/\bfeedPet\s*\(/);
    }
  });

  it('and feedAndGrade does both halves', () => {
    const actions = source('actions.ts');
    const body = actions.slice(actions.indexOf('export async function feedAndGrade'));

    expect(body).toMatch(/feedPet\(/);
    expect(body).toMatch(/gradeFeed\(/);
  });
});
