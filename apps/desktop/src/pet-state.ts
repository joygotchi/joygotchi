import { HOLD_MS, MOTION, stateForEvent, type AgentEvent, type PetState } from '@joygotchi/pet';

export { HOLD_MS, MOTION };

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

