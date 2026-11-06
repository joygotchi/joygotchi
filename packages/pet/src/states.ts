/**
 * The animation states a pet can be in.
 *
 * Deliberately the same nine rows petdex renders, in the same order, so a
 * spritesheet made for one works in the other. JOYGOTCHI ships GIFs rather
 * than sprite atlases today (see `PetPackage.states`), but the vocabulary is
 * what the desktop app and any future renderer agree on.
 */
export const PET_STATES = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review'
] as const;

export type PetState = (typeof PET_STATES)[number];

/** What a coding agent is doing, as the desktop app's hook server reports it. */
export type AgentEvent =
  | { kind: 'tool-start'; tool: string }
  | { kind: 'tool-end'; tool: string; ok: boolean }
  | { kind: 'prompt' }
  | { kind: 'idle' };

/**
 * Map an agent's activity onto a pet state.
 *
 * One place, because the desktop app and the web preview must agree: a demo
 * that animates differently from the real thing is worse than no demo.
 */
export function stateForEvent(event: AgentEvent): PetState {
  switch (event.kind) {
    case 'prompt':
      return 'waiting';
    case 'tool-start':
      return event.tool === 'Read' || event.tool === 'Grep' ? 'review' : 'running';
    case 'tool-end':
      return event.ok ? 'waving' : 'failed';
    case 'idle':
      return 'idle';
  }
}
