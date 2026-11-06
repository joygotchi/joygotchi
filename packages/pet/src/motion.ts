import type { PetState } from './states.js';

/**
 * What each state looks like, in one place.
 *
 * The desktop app draws the pet and the web app previews it, and before this
 * existed they each had their own copy of the mapping — which is a guarantee
 * that the preview eventually lies about what the pet does.
 *
 * It is CSS rather than frames because of the art. A petdex pet is an 8×9
 * atlas with a row per state; a JOYGOTCHI pet is one idle loop per evolution
 * phase, so "running" has to be *motion over* that loop rather than a
 * different drawing. The day a pet ships nine rows, `PetPackage.states` points
 * each state at its own file and the renderer stops needing this — the
 * vocabulary below does not change.
 */

export type StateInfo = {
  label: string;
  /** What makes the pet do this, in the words a player would use. */
  trigger: string;
  /** CSS animation name, defined in `MOTION_CSS`. */
  motion: string;
  /** Seconds the pet holds this before settling back to idle. 0 = forever. */
  holdSeconds: number;
};

export const STATE_INFO: Record<PetState, StateInfo> = {
  idle: {
    label: 'Idle',
    trigger: 'Nothing is happening. The pet breathes.',
    motion: 'jg-breathe',
    holdSeconds: 0
  },
  waiting: {
    label: 'Waiting',
    trigger: 'You asked your agent for something and it is thinking.',
    motion: 'jg-breathe',
    holdSeconds: 30
  },
  running: {
    label: 'Running',
    trigger: 'Your agent started a tool — a command, an edit, a build.',
    motion: 'jg-bob',
    holdSeconds: 30
  },
  review: {
    label: 'Review',
    trigger: 'Your agent is reading or searching rather than changing things.',
    motion: 'jg-lean',
    holdSeconds: 30
  },
  waving: {
    label: 'Waving',
    trigger: 'A tool finished and it worked.',
    motion: 'jg-wave',
    holdSeconds: 2.5
  },
  failed: {
    label: 'Failed',
    trigger: 'A tool finished and it did not work. Held longest, on purpose.',
    motion: 'jg-shake',
    holdSeconds: 4
  },
  jumping: {
    label: 'Jumping',
    trigger: 'Something went well enough to be worth a jump.',
    motion: 'jg-hop',
    holdSeconds: 2
  },
  'running-right': {
    label: 'Run right',
    trigger: 'The pet crosses the window to the right.',
    motion: 'jg-scurry-right',
    holdSeconds: 2
  },
  'running-left': {
    label: 'Run left',
    trigger: 'The same, the other way, mirrored.',
    motion: 'jg-scurry-left',
    holdSeconds: 2
  },
  feeding: {
    label: 'Feeding',
    trigger: 'You fed it. Credits left your balance for this.',
    motion: 'jg-munch',
    holdSeconds: 3
  },
  battling: {
    label: 'Battling',
    trigger: 'It attacked another pet, or was attacked.',
    motion: 'jg-lunge',
    holdSeconds: 3
  }
};

/** State → CSS animation name. */
export const MOTION = Object.fromEntries(
  Object.entries(STATE_INFO).map(([state, info]) => [state, info.motion])
) as Record<PetState, string>;

/** State → how long it holds, in milliseconds. */
export const HOLD_MS = Object.fromEntries(
  Object.entries(STATE_INFO).map(([state, info]) => [state, info.holdSeconds * 1000])
) as Record<PetState, number>;

/**
 * The keyframes themselves, as a string both apps inject.
 *
 * Shipping CSS from a TypeScript package is unusual, and the alternative was
 * two copies of these keyframes drifting apart — the web preview showing one
 * thing and the desktop pet doing another is exactly the bug a preview exists
 * to prevent.
 *
 * Names are prefixed `jg-` because this gets injected into pages that have
 * their own animations.
 */
export const MOTION_CSS = `
@keyframes jg-breathe {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-2px) scale(1.02); }
}
@keyframes jg-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
}
@keyframes jg-hop {
  0%, 100% { transform: translateY(0); }
  30% { transform: translateY(-26px); }
  60% { transform: translateY(0) scaleY(0.92); }
}
@keyframes jg-wave {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(-7deg); }
  75% { transform: rotate(7deg); }
}
@keyframes jg-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-6px) rotate(-3deg); }
  60% { transform: translateX(6px) rotate(3deg); }
}
@keyframes jg-lean {
  0%, 100% { transform: translateX(0) rotate(0deg); }
  50% { transform: translateX(6px) rotate(4deg); }
}
@keyframes jg-scurry-right {
  0%, 100% { transform: translateX(-18px); }
  50% { transform: translateX(18px); }
}
@keyframes jg-scurry-left {
  0%, 100% { transform: translateX(18px) scaleX(-1); }
  50% { transform: translateX(-18px) scaleX(-1); }
}
@keyframes jg-munch {
  0%, 100% { transform: translateY(0) scale(1, 1); }
  25% { transform: translateY(2px) scale(1.06, 0.94); }
  50% { transform: translateY(-1px) scale(0.96, 1.05); }
}
@keyframes jg-lunge {
  0%, 100% { transform: translateX(0) rotate(0deg); }
  35% { transform: translateX(-10px) rotate(-6deg); }
  55% { transform: translateX(14px) rotate(8deg); }
}
`;

/** How fast each motion cycles. A lunge should not amble. */
export const MOTION_DURATION: Partial<Record<PetState, number>> = {
  feeding: 0.6,
  battling: 0.7,
  jumping: 1.1,
  failed: 0.5,
  waving: 1.2
};

export const motionDuration = (state: PetState) => MOTION_DURATION[state] ?? 1.8;
