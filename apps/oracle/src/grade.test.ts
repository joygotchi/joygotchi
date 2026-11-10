import { describe, expect, it, vi } from 'vitest';
import { gradeMeal, gradeIn, type Grader } from './grade.ts';

const STAKE = 'jg-stake-5656.testnet';
const OWNER = 'kurodenjiro2.testnet';

/** A transaction shaped like the real one that bought pet 8 its meal. */
const meal = (over: Record<string, unknown> = {}) => ({
  transaction: { signer_id: OWNER, receiver_id: STAKE },
  receipts_outcome: [
    {
      outcome: {
        executor_id: STAKE,
        logs: [
          'EVENT_JSON:' +
            JSON.stringify({
              standard: 'joygotchi',
              event: 'credit_spent',
              data: [
                {
                  account_id: OWNER,
                  action: 'ai_feed',
                  pet_id: 8,
                  amount: 2000,
                  lens_applied: false,
                  ...over
                }
              ]
            })
        ]
      }
    }
  ]
});

const deps = (over: Partial<Grader> = {}): Grader => ({
  stake: STAKE,
  view: async () => false as never,
  txStatus: async () => meal(),
  opinion: async () => '30',
  award: async () => 'TXHASH',
  ...over
});

describe('gradeMeal', () => {
  it('pays the graded XP for a real meal', async () => {
    const award = vi.fn(async () => 'TXHASH');
    const result = await gradeMeal('MEAL1', OWNER, deps({ award }));
    expect(result).toMatchObject({ ok: true, petId: 8, xp: 30, lens: false });
    expect(award).toHaveBeenCalledWith(8, 30, 'MEAL1');
  });

  it('doubles for a Focus Lens, once', async () => {
    const result = await gradeMeal(
      'MEAL1',
      OWNER,
      deps({ txStatus: async () => meal({ lens_applied: true }) })
    );
    expect(result).toMatchObject({ ok: true, xp: 60 });
  });

  it('refuses a meal the contract has already graded, without reading anything', async () => {
    const txStatus = vi.fn(async () => meal());
    const result = await gradeMeal('MEAL1', OWNER, deps({ view: async () => true as never, txStatus }));
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(txStatus).not.toHaveBeenCalled();
  });

  it('refuses a transaction signed by somebody else', async () => {
    const result = await gradeMeal('MEAL1', 'someone.testnet', deps());
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a transaction sent to another contract', async () => {
    const elsewhere = { ...meal(), transaction: { signer_id: OWNER, receiver_id: 'evil.testnet' } };
    const result = await gradeMeal('MEAL1', OWNER, deps({ txStatus: async () => elsewhere }));
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('still pays the floor when the grader will not answer', async () => {
    const result = await gradeMeal(
      'MEAL1',
      OWNER,
      deps({
        opinion: async () => {
          throw new Error('NEAR AI is down');
        }
      })
    );
    expect(result).toMatchObject({ ok: true, xp: 1 });
  });

  it('reports a failed signature rather than claiming the XP was paid', async () => {
    const result = await gradeMeal(
      'MEAL1',
      OWNER,
      deps({
        award: async () => {
          throw new Error('not enough gas');
        }
      })
    );
    expect(result).toMatchObject({ ok: false, status: 502, why: 'not enough gas' });
  });

  it('decides without signing in a dry run', async () => {
    const result = await gradeMeal('MEAL1', OWNER, deps({ award: null }));
    expect(result).toMatchObject({ ok: true, xp: 30 });
    // No transaction, because none was sent.
    expect(result).not.toHaveProperty('tx');
  });

  it('wants a transaction hash', async () => {
    expect(await gradeMeal('', OWNER, deps())).toMatchObject({ status: 400 });
    expect(await gradeMeal('x'.repeat(65), OWNER, deps())).toMatchObject({ status: 400 });
  });
});

describe('gradeIn', () => {
  it('takes the grade and clamps it to what the contract allows', () => {
    expect(gradeIn({ grade: 30 })).toBe('30');
    expect(gradeIn({ grade: 500 })).toBe('36');
    expect(gradeIn({ grade: 0 })).toBe('1');
  });

  it('ignores a lens the reply tries to claim, so it cannot double the pay', () => {
    // `xpFrom` applies the lens, from the receipt. Nothing in the reply can.
    expect(gradeIn({ grade: 10, lens: true, xp: 999 })).toBe('10');
  });

  it('is empty when there is no number, which scores the floor', () => {
    expect(gradeIn({ error: 'no key' })).toBe('');
    expect(gradeIn(null)).toBe('');
  });
});
