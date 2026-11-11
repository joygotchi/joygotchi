import { describe, expect, it } from 'vitest';
import { planIntent, type PlanContext } from './plan';

const base = (over: Partial<PlanContext> = {}): PlanContext => ({
  pet: { seconds_until_starving: '40000', level: 2, evolution_phase: 1 } as never,
  account: { credit_balance: '5000000', pending_credits: '0' } as never,
  mine: true,
  petName: 'KURO',
  ownedPets: 1,
  minesAt: 0,
  signable: () => true,
  ...over
});

describe('planIntent', () => {
  it('allows what the chain allows', () => {
    expect(planIntent({ kind: 'feed' }, base())).toMatchObject({ ok: true, method: 'feed_pet' });
  });

  it('refuses a pet that is not yours, before anything else', () => {
    const plan = planIntent({ kind: 'feed' }, base({ mine: false }));
    expect(plan).toMatchObject({ ok: false });
    expect((plan as { why: string }).why).toMatch(/not yours/);
  });

  it('will not feed a starved pet, and will not revive a living one', () => {
    const dead = base({ pet: { seconds_until_starving: '0', level: 2 } as never });
    expect(planIntent({ kind: 'feed' }, dead)).toMatchObject({ ok: false });
    expect(planIntent({ kind: 'revive' }, dead)).toMatchObject({ ok: true });
    expect(planIntent({ kind: 'revive' }, base())).toMatchObject({ ok: false });
  });

  it('checks the level before offering to evolve', () => {
    expect(planIntent({ kind: 'evolve' }, base())).toMatchObject({ ok: true });

    const young = base({ pet: { seconds_until_starving: '40000', level: 0, evolution_phase: 1 } as never });
    expect(planIntent({ kind: 'evolve' }, young)).toMatchObject({ ok: false });
  });

  it('refuses when the balance cannot cover the contract price', () => {
    const broke = base({ account: { credit_balance: '0', pending_credits: '0' } as never });
    const plan = planIntent({ kind: 'feed' }, broke);
    expect(plan).toMatchObject({ ok: false });
    expect((plan as { why: string }).why).toMatch(/not enough/);
  });

  it('counts claimable credits, because claiming happens on the way', () => {
    const pending = base({ account: { credit_balance: '0', pending_credits: '5000000' } as never });
    expect(planIntent({ kind: 'feed' }, pending)).toMatchObject({ ok: true });
  });

  it('refuses a method this session key was granted before', () => {
    const old = base({ signable: (m) => m !== 'evolve_pet' });
    const plan = planIntent({ kind: 'evolve' }, old);
    expect((plan as { why: string }).why).toMatch(/reconnect/i);
  });

  it('does not offer to claim nothing, or to mine on cooldown', () => {
    expect(planIntent({ kind: 'claim' }, base())).toMatchObject({ ok: false });
    expect(
      planIntent({ kind: 'mine' }, base({ minesAt: Date.now() + 3_600_000 }))
    ).toMatchObject({ ok: false });
  });

  it('will not turn on something already on', () => {
    const on = base({
      account: { credit_balance: '5000000', pending_credits: '0', auto_feed_budget: '45000' } as never
    });
    expect(planIntent({ kind: 'auto_feed', on: true }, on)).toMatchObject({ ok: false });
    expect(planIntent({ kind: 'auto_feed', on: false }, on)).toMatchObject({ ok: true });
  });

  /*
   * The number on the card never comes from the model: the intent carries a
   * kind and at most an item id, and the price is looked up here.
   */
  it('prices from the contract, not from anything that was said', () => {
    const plan = planIntent({ kind: 'buy_item', itemId: 103 }, base());
    expect(plan).toMatchObject({ ok: true, cost: 0.02 });
  });
});
