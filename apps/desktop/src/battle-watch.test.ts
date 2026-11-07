import { describe, expect, it } from 'vitest';
import { detectBattle, markSelfFight, startedHere } from './battle-watch';
import type { ChainPetSummary } from './chain';

const pet = (
  pet_id: number,
  fields: Partial<ChainPetSummary> = {}
): ChainPetSummary => ({
  pet_id,
  owner_id: `p${pet_id}.testnet`,
  name: `PET${pet_id}`,
  rarity: 'common',
  level: 0,
  star: 0,
  last_attacked: '0',
  last_attack_used: '0',
  ...fields
});

const NOW = '1794000000000000000';

describe('detectBattle', () => {
  it('says nothing on the first read, however old the fight', () => {
    // Every timestamp looks new against an empty baseline. Without this the
    // window acts out last week's fight the moment it opens.
    expect(detectBattle(1, [], [pet(1, { last_attacked: NOW })])).toBeNull();
  });

  it('says nothing when neither side moved', () => {
    const before = [pet(1, { last_attacked: NOW }), pet(2)];
    expect(detectBattle(1, before, before)).toBeNull();
  });

  it('reports a loss and names who landed it', () => {
    const before = [pet(1), pet(2)];
    const after = [pet(1, { last_attacked: NOW }), pet(2, { last_attack_used: NOW })];

    const seen = detectBattle(1, before, after);
    expect(seen?.outcome).toBe('lost');
    expect(seen?.opponent?.pet_id).toBe(2);
  });

  it('reports a win, which lands on the other field', () => {
    // `last_attack_used` goes to whoever won, not to whoever swung — so a pet
    // that was attacked and won is found here, not under `last_attacked`.
    const before = [pet(1), pet(2)];
    const after = [pet(1, { last_attack_used: NOW }), pet(2, { last_attacked: NOW })];

    const seen = detectBattle(1, before, after);
    expect(seen?.outcome).toBe('won');
    expect(seen?.opponent?.pet_id).toBe(2);
  });

  it('prefers the loss when two fights land between reads', () => {
    const before = [pet(1), pet(2), pet(3)];
    const after = [
      pet(1, { last_attacked: NOW, last_attack_used: '1794000000000000001' }),
      pet(2, { last_attack_used: NOW }),
      pet(3, { last_attacked: '1794000000000000001' })
    ];

    expect(detectBattle(1, before, after)?.outcome).toBe('lost');
  });

  it('still reports the fight when the opponent is off the fetched page', () => {
    // The pet list is capped, so a fight against pet #80 can arrive with no
    // counterpart in hand. Knowing you lost is worth more than knowing to whom.
    const seen = detectBattle(1, [pet(1)], [pet(1, { last_attacked: NOW })]);
    expect(seen?.outcome).toBe('lost');
    expect(seen?.opponent).toBeNull();
  });

  it('does not match two pets that merely both have zero', () => {
    // Every pet that has never fought carries 0 in both fields; matching on
    // equality alone would pair your pet with the first stranger in the list.
    const before = [pet(1), pet(2), pet(3)];
    const after = [pet(1, { last_attacked: NOW }), pet(2), pet(3)];

    expect(detectBattle(1, before, after)?.opponent).toBeNull();
  });

  it('survives a field the chain left out', () => {
    const before = [{ ...pet(1), last_attacked: undefined }];
    const after = [{ ...pet(1), last_attacked: NOW }];
    expect(detectBattle(1, before, after)?.outcome).toBe('lost');
  });
});

describe('startedHere', () => {
  it('is false until a fight is started from this window', () => {
    expect(startedHere(0)).toBe(false);
  });

  it('covers the gap between pressing Fight and the result landing', () => {
    // The result arrives in a cross-contract callback and the poll that sees
    // it runs every twelve seconds, so the window has to outlast both.
    markSelfFight(1_000);
    expect(startedHere(1_000)).toBe(true);
    expect(startedHere(30_000)).toBe(true);
    expect(startedHere(61_001)).toBe(false);
  });
});
