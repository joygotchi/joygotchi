/**
 * The treasury's one off-chain step, watched.
 *
 * The staking contract funds each 30-day epoch from its reserve by itself,
 * back to back, for as long as the reserve holds a whole epoch. What it
 * cannot do is buy the credits that fill the reserve: that is a purchase on
 * NEAR AI with real money, and it stays a person's job. This tells that
 * person when, and how much — before the stream stops, not after.
 *
 * Pure, like `decide.ts`: it reads a pool view and a clock and says nothing
 * to the network.
 */

/** The part of `pet-stake::get_pool` this reads. Amounts in micro-credits. */
export type PoolView = {
  epoch_budget: string;
  epoch_target: string;
  epoch_ends_at: string; // nanoseconds
  sale_reserve: string;
  staked_pets: number;
};

export type TreasuryStatus =
  | { kind: 'ok'; epochsFunded: number; endsAt: Date }
  | { kind: 'low'; buyCredits: number; endsAt: Date; daysLeft: number }
  | { kind: 'stopped'; buyCredits: number }
  | { kind: 'idle' };

const MICRO = 1_000_000;
const DAY_MS = 86_400_000;

/** Warn this long before the current epoch ends with nothing to follow it. */
export const WARN_DAYS = 7;

export function treasuryStatus(pool: PoolView, nowMs: number): TreasuryStatus {
  const target = Number(pool.epoch_target) / MICRO;
  const reserve = Number(pool.sale_reserve) / MICRO;
  const endsAt = new Date(Number(BigInt(pool.epoch_ends_at) / 1_000_000n));
  const short = Math.max(0, Math.ceil((target - reserve) * 100) / 100);

  if (target <= 0 || pool.staked_pets === 0) return { kind: 'idle' };

  // Stopped: the epoch is over and the reserve could not fund the next one.
  if (Number(pool.epoch_budget) === 0 || endsAt.getTime() <= nowMs) {
    return { kind: 'stopped', buyCredits: short };
  }

  // Running, and the reserve already holds the next epoch.
  if (reserve >= target) {
    return { kind: 'ok', epochsFunded: 1 + Math.floor(reserve / target), endsAt };
  }

  const daysLeft = (endsAt.getTime() - nowMs) / DAY_MS;
  if (daysLeft <= WARN_DAYS) {
    return { kind: 'low', buyCredits: short, endsAt, daysLeft: Math.round(daysLeft * 10) / 10 };
  }
  return { kind: 'ok', epochsFunded: 1, endsAt };
}
