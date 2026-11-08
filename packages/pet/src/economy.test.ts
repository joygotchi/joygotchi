import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_METHODS,
  ACTION_PRICE,
  AUTO_FEED_DAILY_BUDGET,
  AUTO_FEED_HOURS,
  GAME_METHODS,
  ITEMS,
  STAKE_METHODS,
  contractForMethod,
  slotForMethod,
  formatCredits,
  toMicroCredits
} from './economy.js';

const contracts = {
  stake: 'jg-stake-1.testnet',
  game: 'jg-game-1.testnet',
  accessory: 'jg-acc-1.testnet'
};

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
    expect(contractForMethod('buy_pet', contracts)).toBeNull();
  });

  it('affords a day of auto-feeding, or the budget means nothing', () => {
    // A feed buys twelve hours, so a daily budget has to cover at least two.
    expect(AUTO_FEED_DAILY_BUDGET).toBeGreaterThanOrEqual(
      ACTION_PRICE.auto_feed * (24 / AUTO_FEED_HOURS)
    );
  });

  it('routes staking to the lab, now that it takes no deposit', () => {
    expect(contractForMethod('stake_pet', contracts)).toBe(contracts.stake);
    expect(contractForMethod('unstake_pet', contracts)).toBe(contracts.stake);
  });

  it('keeps the three lists disjoint', () => {
    // A method in two lists would route to whichever check ran first, which
    // is a key signing for the wrong contract and a node refusing it.
    const all = [...STAKE_METHODS, ...GAME_METHODS, ...ACCESSORY_METHODS];
    expect(new Set(all).size).toBe(all.length);
  });

  it('routes wearing to the accessory contract, and names its key', () => {
    expect(contractForMethod('equip', contracts)).toBe(contracts.accessory);
    expect(contractForMethod('unequip', contracts)).toBe(contracts.accessory);
    expect(slotForMethod('equip')).toBe('accessory');
    expect(slotForMethod('claim_credits')).toBe('lab');
    expect(slotForMethod('attack')).toBe('game');
    expect(slotForMethod('mint')).toBeNull();
  });

  it('has no accessory contract to route to on an older session', () => {
    // Two-key sessions predate the third contract; routing must say no
    // rather than send the call to the lab.
    expect(contractForMethod('equip', { stake: 's.testnet', game: 'g.testnet' })).toBeNull();
  });

  it('grants nothing payable, because a session key cannot attach a deposit', () => {
    // `stake_pet` and `unstake_pet` are absent from this list on purpose:
    // they are the two the contract made non-payable so they could be granted.
    // Everything here still takes NEAR, so a session key could not call it.
    for (const method of [...STAKE_METHODS, ...GAME_METHODS]) {
      expect(['list_pet', 'buy_pet', 'nft_transfer', 'nft_mint']).not.toContain(method);
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
