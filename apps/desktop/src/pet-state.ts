import { stateForEvent, type AgentEvent, type PetState } from '@joygotchi/pet';

/**
 * How long a reaction stays on screen before the pet settles back to idle.
 *
 * A tool call that finishes in 40ms would otherwise flash a frame nobody sees,
 * and a long `cargo build` would leave the pet stuck mid-stride for minutes.
 * Both are handled here rather than in the component, so the rules are testable
 * without a window.
 */
export const HOLD_MS: Record<PetState, number> = {
  idle: 0,
  'running-right': 2_000,
  'running-left': 2_000,
  waving: 2_500,
  jumping: 2_000,
  failed: 4_000,
  waiting: 30_000,
  running: 30_000,
  review: 30_000
};

export type Reaction = {
  state: PetState;
  /** When the pet should fall back to idle, in ms since the epoch. */
  until: number;
};

/**
 * Decide what the pet does next.
 *
 * `tool-end` beats everything, including a `running` that has not expired:
 * finishing is the event a person is waiting to see. A `tool-start` while
 * already running only extends the hold, so a burst of twenty reads does not
 * make the pet twitch twenty times.
 */
export function nextReaction(
  current: Reaction | null,
  event: AgentEvent,
  now = Date.now()
): Reaction {
  const state = stateForEvent(event);
  const until = now + HOLD_MS[state];

  if (current && current.state === state) {
    // Same state again: keep going, just do not let it lapse.
    return { state, until: Math.max(current.until, until) };
  }
  return { state, until };
}

/** The state to render, falling back to idle once a reaction has run out. */
export function visibleState(current: Reaction | null, now = Date.now()): PetState {
  if (!current) return 'idle';
  if (current.state === 'idle') return 'idle';
  return current.until > now ? current.state : 'idle';
}

/**
 * How a state moves, as a CSS animation name.
 *
 * The dragons only have idle loops drawn, so motion is CSS over a still loop
 * rather than nine spritesheet rows that do not exist. Keeping the mapping
 * here means swapping in a real atlas later changes one file.
 */
export const MOTION: Record<PetState, string> = {
  idle: 'breathe',
  'running-right': 'scurry-right',
  'running-left': 'scurry-left',
  waving: 'wave',
  jumping: 'hop',
  failed: 'shake',
  waiting: 'breathe',
  running: 'bob',
  review: 'lean'
};
