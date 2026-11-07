import type { ChainPetSummary } from './chain';

/**
 * Notice a fight your pet was in, without an indexer.
 *
 * Only the `battle_settled` event carries the full story, and reading events
 * means running an indexer or paying one. The pets themselves carry enough,
 * because of how the game contract writes a result:
 *
 *     winner.last_attack_used = now
 *     loser.last_attacked     = now
 *
 * Both in the same callback, from the same `env::block_timestamp()`. So a
 * change in either field on your pet says a fight happened and which side you
 * were on, and the pet holding the *other* field at the very same nanosecond
 * is the one you fought. No guessing, no API key.
 *
 * Note those fields are not attacker/defender: `last_attack_used` lands on
 * whoever won, even when they were the one being attacked. Reading them as
 * "who swung first" gets the outcome backwards.
 */
export type SpectatedBattle = {
  outcome: 'won' | 'lost';
  /** The pet on the other side, or null if it fell outside the fetched page. */
  opponent: ChainPetSummary | null;
  /** The chain timestamp both sides were stamped with, in nanoseconds. */
  at: string;
};

const stamp = (value: string | undefined): bigint => {
  try {
    return BigInt(value ?? '0');
  } catch {
    return 0n;
  }
};

/**
 * Compare two reads of the chain and report a fight that happened between
 * them, or null.
 *
 * `previous` empty means this is the first read: nothing is reported, because
 * every timestamp would look new and the window would act out a fight from
 * last week the moment it opened.
 */
export function detectBattle(
  petId: number,
  previous: readonly ChainPetSummary[],
  current: readonly ChainPetSummary[]
): SpectatedBattle | null {
  if (previous.length === 0) return null;

  const before = previous.find((pet) => pet.pet_id === petId);
  const after = current.find((pet) => pet.pet_id === petId);
  if (!before || !after) return null;

  const lost = stamp(after.last_attacked) > stamp(before.last_attacked);
  const won = stamp(after.last_attack_used) > stamp(before.last_attack_used);

  // Both in one window means two fights landed between reads. The loss is the
  // one worth showing: it is the one that cost something.
  if (!lost && !won) return null;

  const outcome = lost ? 'lost' : 'won';
  const at = lost ? after.last_attacked : after.last_attack_used;

  // The counterpart carries the opposite field, stamped identically.
  const opponent =
    current.find(
      (pet) =>
        pet.pet_id !== petId &&
        stamp(lost ? pet.last_attack_used : pet.last_attacked) === stamp(at) &&
        stamp(at) > 0n
    ) ?? null;

  return { outcome, opponent, at: at ?? '0' };
}

/**
 * A fight this window started, so the watcher does not narrate it twice.
 *
 * The panel's own battle screen is already showing the fight; the chain write
 * it produces looks exactly like being attacked by a stranger, because it is
 * the same two fields. Without this, pressing Fight opens the spectator
 * overlay on top of the screen you are already watching.
 *
 * A window rather than an id: the result lands a few seconds after the call,
 * in a callback, and the poll that notices it may be two ticks later.
 */
export const selfFight = { until: 0 };

export const markSelfFight = (now = Date.now()) => {
  selfFight.until = now + 60_000;
};

export const startedHere = (now = Date.now()) => now < selfFight.until;
