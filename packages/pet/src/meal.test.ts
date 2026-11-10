import { describe, expect, it } from 'vitest';
import { MAX_FEED_XP, mealFrom, xpFrom, type TxStatus } from './meal.js';

const STAKE = 'jg-stake-5656.testnet';
const WHO = 'alice.testnet';

const event = (data: Record<string, unknown>, name = 'credit_spent') =>
  `EVENT_JSON:${JSON.stringify({
    standard: 'joygotchi',
    version: '1.0.0',
    event: name,
    data: [data]
  })}`;

const tx = (logs: string[], over: Partial<TxStatus> = {}): TxStatus => ({
  transaction: { signer_id: WHO, receiver_id: STAKE },
  receipts_outcome: [{ outcome: { logs, executor_id: STAKE } }],
  ...over
});

const meal = (over: Record<string, unknown> = {}) =>
  event({
    account_id: WHO,
    action: 'ai_feed',
    pet_id: 6,
    amount: '2000',
    lens_applied: false,
    ...over
  });

describe('mealFrom', () => {
  it('reads the pet and the lens out of the receipts', () => {
    const found = mealFrom(tx([meal({ lens_applied: true })]), {
      stakeContract: STAKE,
      accountId: WHO
    });
    expect(found).toEqual({
      ok: true,
      meal: { petId: 6, accountId: WHO, lensApplied: true, amount: 2000 }
    });
  });

  it('refuses a transaction on somebody else\'s contract', () => {
    // Otherwise anyone can deploy their own copy of this contract, emit a
    // perfectly well-formed event, and mint XP on a real pet.
    const found = mealFrom(tx([meal()], { transaction: { signer_id: WHO, receiver_id: 'mine.testnet' } }), {
      stakeContract: STAKE,
      accountId: WHO
    });
    expect(found).toEqual({ ok: false, why: expect.stringContaining('not sent to this lab') });
  });

  it('refuses somebody else\'s transaction', () => {
    // The hash is public: anybody can read another player's meal off the
    // explorer and ask for the XP from it.
    const found = mealFrom(tx([meal()]), { stakeContract: STAKE, accountId: 'bob.testnet' });
    expect(found.ok).toBe(false);
  });

  it('ignores logs a cross-contract call wrote', () => {
    // A call out to another contract in the same transaction can log
    // anything, including this event.
    const forged: TxStatus = {
      transaction: { signer_id: WHO, receiver_id: STAKE },
      receipts_outcome: [{ outcome: { logs: [meal({ pet_id: 999 })], executor_id: 'evil.testnet' } }]
    };
    expect(mealFrom(forged, { stakeContract: STAKE, accountId: WHO }).ok).toBe(false);
  });

  it('ignores an event for a different action', () => {
    const found = mealFrom(tx([meal({ action: 'train' })]), {
      stakeContract: STAKE,
      accountId: WHO
    });
    expect(found.ok).toBe(false);
  });

  it('ignores an event with somebody else\'s account in it', () => {
    const found = mealFrom(tx([meal({ account_id: 'bob.testnet' })]), {
      stakeContract: STAKE,
      accountId: WHO
    });
    expect(found.ok).toBe(false);
  });

  it('survives a log that is not an event at all', () => {
    const found = mealFrom(tx(['just a log', 'EVENT_JSON:{oops', meal()]), {
      stakeContract: STAKE,
      accountId: WHO
    });
    expect(found.ok).toBe(true);
  });

  it('says so when the transaction bought no meal', () => {
    const found = mealFrom(tx([]), { stakeContract: STAKE, accountId: WHO });
    expect(found).toEqual({ ok: false, why: 'no AI meal in that transaction' });
  });
});

describe('xpFrom', () => {
  it('takes the number out of a sentence', () => {
    expect(xpFrom('I would say 20 out of 36', false)).toBe(20);
  });

  it('doubles for a Focus Lens, which is what the item promises', () => {
    expect(xpFrom('18', true)).toBe(36);
  });

  it('never exceeds the contract cap, so nothing is cut silently on chain', () => {
    // A request for 500 is clamped to 72 by the contract and the caller
    // never learns it, which makes the number nobody can check.
    expect(xpFrom('500', true)).toBe(MAX_FEED_XP);
  });

  it('scores the floor when the model writes no number', () => {
    // The meal was bought and paid for. A model having an off day is not
    // the player's problem.
    expect(xpFrom('that smelled wonderful', false)).toBe(1);
    expect(xpFrom('0', false)).toBe(1);
  });
});
