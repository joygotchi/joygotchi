import { describe, expect, it } from 'vitest';
import { treasuryStatus, type PoolView } from './treasury.ts';

const NOW = Date.UTC(2026, 10, 12);
const DAY = 86_400_000;
const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
const credits = (n: number) => String(n * 1_000_000);

const pool = (over: Partial<PoolView> = {}): PoolView => ({
  epoch_budget: credits(40),
  epoch_target: credits(40),
  epoch_ends_at: ns(NOW + 20 * DAY),
  sale_reserve: credits(100),
  staked_pets: 2,
  ...over
});

describe('treasuryStatus', () => {
  it('is fine while the reserve holds the next epoch', () => {
    expect(treasuryStatus(pool(), NOW)).toMatchObject({ kind: 'ok', epochsFunded: 3 });
  });

  it('warns a week out, with what to buy', () => {
    const status = treasuryStatus(
      pool({ sale_reserve: credits(8.96), epoch_ends_at: ns(NOW + 5 * DAY) }),
      NOW
    );
    expect(status).toMatchObject({ kind: 'low', buyCredits: 31.04, daysLeft: 5 });
  });

  it('stays quiet when the end is still far off', () => {
    expect(treasuryStatus(pool({ sale_reserve: credits(1) }), NOW)).toMatchObject({ kind: 'ok' });
  });

  it('reports a stopped stream and the shortfall', () => {
    const status = treasuryStatus(
      pool({ epoch_budget: '0', sale_reserve: credits(8.96), epoch_ends_at: ns(NOW - DAY) }),
      NOW
    );
    expect(status).toEqual({ kind: 'stopped', buyCredits: 31.04 });
  });

  it('says nothing when no pet is staked or no target is set', () => {
    expect(treasuryStatus(pool({ staked_pets: 0 }), NOW)).toEqual({ kind: 'idle' });
    expect(treasuryStatus(pool({ epoch_target: '0' }), NOW)).toEqual({ kind: 'idle' });
  });
});
