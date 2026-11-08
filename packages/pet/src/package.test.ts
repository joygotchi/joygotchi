import { describe, expect, it } from 'vitest';
import { decodeInstallCode } from './install-code.js';
import {
  HOLD_MS,
  MOTION_CSS,
  PET_STATES,
  STATE_INFO,
  artPath,
  motionDuration,
  stateForEvent,
  isStarving,
  petSlug,
  toPetPackage,
  type ChainPet
} from './index.js';

const chain = { network: 'testnet' as const, contract: 'jg-game-5656.testnet' };

const pet: ChainPet = {
  pet_id: 3,
  owner_id: 'jg-p2-72362.testnet',
  name: 'ANCALAGON',
  category: 'blackdragon',
  rarity: 'common',
  level: 1,
  star: 0,
  evolution_phase: 1,
  starves_at: '1793978723770948862'
};

describe('toPetPackage', () => {
  it('carries the chain across, so the CLI can verify what it installed', () => {
    const pkg = toPetPackage(pet, chain);

    expect(pkg.chain).toEqual({ ...chain, owner: 'jg-p2-72362.testnet' });
    expect(pkg.petId).toBe(3);
    expect(decodeInstallCode(pkg.installCode)).toBe(3);
  });

  it('fills every state, because the renderer looks all nine up', () => {
    const pkg = toPetPackage(pet, chain);
    for (const state of PET_STATES) {
      expect(pkg.states[state]).toBe('blackdragon/1.gif');
    }
  });

  it('falls back rather than trusting a category or rarity it does not know', () => {
    // The contract is the authority on these, but a renamed category should
    // show a dragon, not a broken image.
    const odd = toPetPackage({ ...pet, category: 'wyvern', rarity: 'MYTHIC' }, chain);
    expect(odd.kind).toBe('blackdragon');
    expect(odd.rarity).toBe('common');
  });

  it('normalises rarity case, which the contract lowercases and the UI does not', () => {
    expect(toPetPackage({ ...pet, rarity: 'Legendary' }, chain).rarity).toBe('legendary');
  });

  it('clamps the evolution phase into what has art', () => {
    expect(toPetPackage({ ...pet, evolution_phase: 4 }, chain).states.idle).toBe(
      'blackdragon/3.gif'
    );
    expect(toPetPackage({ ...pet, evolution_phase: undefined }, chain).evolutionPhase).toBe(1);
    expect(toPetPackage({ ...pet, evolution_phase: 0 }, chain).evolutionPhase).toBe(1);
  });
});

describe('artPath', () => {
  it('stops at phase 3, the last one drawn', () => {
    expect(artPath('greendragon', 1)).toBe('greendragon/1.gif');
    expect(artPath('greendragon', 3)).toBe('greendragon/3.gif');
    expect(artPath('greendragon', 4)).toBe('greendragon/3.gif');
  });
});

describe('petSlug', () => {
  it('keeps the id, because two players name their dragon the same thing', () => {
    expect(petSlug({ pet_id: 3, name: 'ANCALAGON' })).toBe('ancalagon-3');
    expect(petSlug({ pet_id: 9, name: 'ANCALAGON' })).toBe('ancalagon-9');
  });

  it('survives a name that is all punctuation, since it becomes a folder', () => {
    expect(petSlug({ pet_id: 5, name: '???' })).toBe('pet-5');
    expect(petSlug({ pet_id: 6, name: '  Smaug the Golden!  ' })).toBe('smaug-the-golden-6');
  });
});

describe('isStarving', () => {
  // `starves_at` is a deadline in nanoseconds. Reading it as "seconds left" is
  // the bug this project already shipped once.
  const deadlineMs = 1_700_000_000_000;
  const deadlineNs = String(deadlineMs * 1e6);

  it('compares against the deadline, not a duration', () => {
    expect(isStarving({ ...pet, starves_at: deadlineNs }, deadlineMs - 1_000)).toBe(false);
    expect(isStarving({ ...pet, starves_at: deadlineNs }, deadlineMs + 1_000)).toBe(true);
  });

  it('treats a missing deadline as "not starving", not as 1970', () => {
    expect(isStarving({ ...pet, starves_at: undefined })).toBe(false);
    expect(isStarving({ ...pet, starves_at: '0' })).toBe(false);
  });
});

describe('the state vocabulary', () => {
  it('keeps petdex order for the first nine, so their atlases drop in', () => {
    // A petdex spritesheet is rows in this order. Reordering silently remaps
    // every imported pet's animations.
    expect(PET_STATES.slice(0, 9)).toEqual([
      'idle',
      'running-right',
      'running-left',
      'waving',
      'jumping',
      'failed',
      'waiting',
      'running',
      'review'
    ]);
  });

  it('describes every state, including the two that are ours', () => {
    for (const state of PET_STATES) {
      const info = STATE_INFO[state];
      expect(info, state).toBeTruthy();
      expect(info.label, state).toBeTruthy();
      expect(info.trigger, state).toBeTruthy();
      expect(MOTION_CSS, state).toContain(`@keyframes ${info.motion}`);
    }
  });

  it('holds idle forever and everything else for a while', () => {
    expect(HOLD_MS.idle).toBe(0);
    for (const state of PET_STATES.filter((s) => s !== 'idle')) {
      expect(HOLD_MS[state], state).toBeGreaterThan(0);
    }
  });

  it('shows a failure longer than a success, since it is the one you missed', () => {
    expect(HOLD_MS.failed).toBeGreaterThan(HOLD_MS.waving);
  });

  it('maps a game event to a game state', () => {
    expect(stateForEvent({ kind: 'game', what: 'fed' })).toBe('feeding');
    expect(stateForEvent({ kind: 'game', what: 'battled' })).toBe('battling');
    expect(stateForEvent({ kind: 'game', what: 'petted' })).toBe('waving');
  });

  it('gives a lunge a shorter cycle than an amble', () => {
    expect(motionDuration('battling')).toBeLessThan(motionDuration('idle'));
    expect(motionDuration('feeding')).toBeLessThan(motionDuration('idle'));
  });
});
