import { describe, expect, it, vi } from 'vitest';
import { feedXp } from '@joygotchi/pet';
import { gradeMeal, type Grader } from './grade.ts';

const STAKE = 'jg-stake-5656.testnet';
const GAME = 'jg-game-5656.testnet';
const OWNER = 'kurodenjiro2.testnet';

/**
 * A transaction shaped like a real feed: `feed_pet` to the staking contract,
 * and the `pet_fed` event its callback writes once the game has accepted.
 */
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
              event: 'pet_fed',
              data: [
                {
                  account_id: OWNER,
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

/*
 * `view` answers two different questions now: `meal_was_graded` on the stake
 * contract, and `get_pet` on the game contract. The default says no to the
 * first and gives a starved pet for the second, which is the shape the real
 * KURO meal had.
 */
const deps = (over: Partial<Grader> = {}): Grader => ({
  stake: STAKE,
  game: GAME,
  view: (async (contractId: string) =>
    contractId === GAME ? { seconds_until_starving: 0 } : false) as Grader['view'],
  txStatus: async () => meal(),
  award: async () => 'TXHASH',
  ...over
});

describe('gradeMeal', () => {
  it('pays the XP the meal earns for a real meal', async () => {
    const award = vi.fn(async () => 'TXHASH');
    const expected = feedXp({ secondsUntilStarving: 0, meal: 'MEAL1', lensApplied: false });

    const result = await gradeMeal('MEAL1', OWNER, deps({ award }));

    expect(result).toMatchObject({ ok: true, petId: 8, xp: expected, lens: false });
    expect(award).toHaveBeenCalledWith(8, expected, 'MEAL1');
  });

  it('doubles for a Focus Lens, once', async () => {
    const plain = feedXp({ secondsUntilStarving: 0, meal: 'MEAL1', lensApplied: false });

    const result = await gradeMeal(
      'MEAL1',
      OWNER,
      deps({ txStatus: async () => meal({ lens_applied: true }) })
    );

    expect(result).toMatchObject({ ok: true, xp: plain * 2 });
  });

  it('reads hunger off the chain, so a hungry pet is paid more', async () => {
    const wellFed = (await gradeMeal(
      'MEAL1',
      OWNER,
      deps({
        view: (async (contractId: string) =>
          contractId === GAME ? { seconds_until_starving: 40 * 3_600 } : false) as Grader['view']
      })
    )) as { xp: number };
    const starved = (await gradeMeal('MEAL1', OWNER, deps())) as { xp: number };

    expect(starved.xp).toBeGreaterThan(wellFed.xp);
  });

  it('refuses a meal the contract has already graded, without reading anything', async () => {
    const txStatus = vi.fn(async () => meal());
    const result = await gradeMeal(
      'MEAL1',
      OWNER,
      deps({ view: (async () => true) as Grader['view'], txStatus })
    );
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(txStatus).not.toHaveBeenCalled();
  });

  it('refuses when the pet cannot be read, rather than guessing its hunger', async () => {
    const result = await gradeMeal(
      'MEAL1',
      OWNER,
      deps({
        view: (async (contractId: string) =>
          contractId === GAME ? null : false) as Grader['view']
      })
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
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

  it('pays in full when the pet has nothing to say', async () => {
    // The line is flavour. It is fetched after the signature, so a service
    // that is down costs the player a sentence and not the XP.
    const expected = feedXp({ secondsUntilStarving: 0, meal: 'MEAL1', lensApplied: false });
    const result = await gradeMeal(
      'MEAL1',
      OWNER,
      deps({
        line: async () => {
          throw new Error('NEAR AI is down');
        }
      })
    );
    expect(result).toMatchObject({ ok: true, xp: expected, line: null });
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
    const expected = feedXp({ secondsUntilStarving: 0, meal: 'MEAL1', lensApplied: false });
    const result = await gradeMeal('MEAL1', OWNER, deps({ award: null }));
    expect(result).toMatchObject({ ok: true, xp: expected });
    // No transaction, because none was sent.
    expect(result).not.toHaveProperty('tx');
  });

  it('wants a transaction hash', async () => {
    expect(await gradeMeal('', OWNER, deps())).toMatchObject({ status: 400 });
    expect(await gradeMeal('x'.repeat(65), OWNER, deps())).toMatchObject({ status: 400 });
  });
});
