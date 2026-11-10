import { describe, expect, it } from 'vitest';
import { FEED_BANDS, MAX_FEED_XP, MIN_FEED_XP, feedXp, mealFrom, type TxStatus } from './meal.js';

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

describe('feedXp', () => {
  const HASH = '81Jn2xyLNwprqNon9JXusWznhH4S9NqjNaWC1QDS3NmU';
  const xp = (hours: number, meal = HASH, lensApplied = false) =>
    feedXp({ secondsUntilStarving: hours * 3_600, meal, lensApplied });

  it('pays the hungriest band to a pet that has already starved', () => {
    expect(xp(0)).toBeGreaterThanOrEqual(26);
    expect(xp(0)).toBeLessThanOrEqual(MAX_FEED_XP / 2);
  });

  it('puts each hunger state in its own band', () => {
    const starved = xp(0);
    const famished = xp(0.5);
    const peckish = xp(3);
    const wellFed = xp(40);

    expect(famished).toBe(starved);
    expect(peckish).toBeGreaterThanOrEqual(18);
    expect(peckish).toBeLessThanOrEqual(24);
    expect(wellFed).toBeGreaterThanOrEqual(MIN_FEED_XP);
    expect(wellFed).toBeLessThanOrEqual(16);
    expect(starved).toBeGreaterThan(peckish);
    expect(peckish).toBeGreaterThan(wellFed);
  });

  /*
   * The whole point of dropping the model: the same meal always pays the
   * same, and anyone holding the hash can check it.
   */
  it('is reproducible for the same meal', () => {
    expect(xp(0)).toBe(xp(0));
    expect(xp(3, 'AAAA')).toBe(xp(3, 'AAAA'));
  });

  it('varies with the meal, so a band is not one flat number', () => {
    const hashes = ['AAAA', 'BBBB', 'CCCC', HASH, 'zzzz9', '11111', 'Qm7xKd'];
    const scores = new Set(hashes.map((meal) => xp(0, meal)));
    expect(scores.size).toBeGreaterThan(1);
  });

  it('does not give an anagram of a hash the same roll', () => {
    expect(xp(0, 'ABCD')).not.toBe(xp(0, 'DCBA'));
  });

  it('keeps the neglect gap near what was measured, around 2.2x', () => {
    const hashes = ['AAAA', 'BBBB', 'CCCC', HASH, 'zzzz9', '11111', 'Qm7xKd', 'abc123'];
    const mean = (hours: number) =>
      hashes.reduce((total, meal) => total + xp(hours, meal), 0) / hashes.length;

    const ratio = mean(0) / mean(40);
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.6);
  });

  it('doubles for a Focus Lens and never passes the contract cap', () => {
    expect(xp(0, HASH, true)).toBe(xp(0) * 2);
    for (const hours of [0, 0.5, 3, 40]) {
      expect(xp(hours, HASH, true)).toBeLessThanOrEqual(MAX_FEED_XP);
    }
  });

  it('treats a negative or absurd deadline as starved rather than crashing', () => {
    expect(xp(-100)).toBeGreaterThanOrEqual(26);
    expect(feedXp({ secondsUntilStarving: Infinity, meal: HASH, lensApplied: false }))
      .toBeGreaterThanOrEqual(MIN_FEED_XP);
  });

  it('never leaves a band asking for more than the contract allows', () => {
    for (const band of FEED_BANDS) {
      expect(band.low).toBeGreaterThanOrEqual(MIN_FEED_XP);
      expect(band.high).toBeLessThanOrEqual(MAX_FEED_XP / 2);
    }
  });

  it('copes with an empty meal reference', () => {
    expect(xp(0, '')).toBeGreaterThanOrEqual(26);
  });
});
