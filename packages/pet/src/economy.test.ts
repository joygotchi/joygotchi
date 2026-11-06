import { describe, expect, it } from 'vitest';
import {
  ACTION_PRICE,
  GAME_METHODS,
  ITEMS,
  STAKE_METHODS,
  contractForMethod,
  formatCredits,
  toMicroCredits
} from './economy.js';

const contracts = { stake: 'jg-stake-1.testnet', game: 'jg-game-1.testnet' };

describe('session methods', () => {
  it('sends each method to the contract it actually lives on', () => {
    // A function-call key is bound to one contract. Sending `attack` to the
    // lab fails on chain with a message about access keys, long after the
    // click.
    expect(contractForMethod('spend_credits', contracts)).toBe(contracts.stake);
    expect(contractForMethod('attack', contracts)).toBe(contracts.game);
  });

  it('refuses a method neither key covers, rather than guessing', () => {
    expect(contractForMethod('nft_transfer', contracts)).toBeNull();
    expect(contractForMethod('stake_pet', contracts)).toBeNull();
  });

  it('keeps the two lists disjoint', () => {
    const overlap = STAKE_METHODS.filter((m) => (GAME_METHODS as readonly string[]).includes(m));
    expect(overlap).toEqual([]);
  });

  it('grants nothing payable, because a session key cannot attach a deposit', () => {
    for (const method of [...STAKE_METHODS, ...GAME_METHODS]) {
      expect(['stake_pet', 'unstake_pet', 'list_pet', 'buy_pet', 'nft_transfer']).not.toContain(
        method
      );
    }
  });

  it('leaves the item market out, since a key that sells can empty a kit', () => {
    expect(STAKE_METHODS).not.toContain('list_item');
    expect(STAKE_METHODS).not.toContain('buy_listing');
  });
});

describe('credits', () => {
  it('truncates rather than rounds, like NEAR amounts', () => {
    expect(formatCredits('1999999', 3)).toBe('1.999');
    expect(formatCredits('2000000')).toBe('2');
    expect(formatCredits('0')).toBe('0');
  });

  it('round trips a price through micro-credits', () => {
    expect(toMicroCredits(ACTION_PRICE.ai_feed)).toBe('2000');
    expect(formatCredits(toMicroCredits(0.5), 3)).toBe('0.5');
  });

  it('prices every item and every action above zero', () => {
    for (const price of Object.values(ACTION_PRICE)) expect(price).toBeGreaterThan(0);
    expect(Object.keys(ITEMS)).toHaveLength(4);
  });
});
