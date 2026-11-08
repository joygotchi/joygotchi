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
  'review',
  // Beyond petdex's nine: these come from the game rather than from a coding
  // agent, so a petdex atlas simply has no row for them and the renderer falls
  // back to idle. Keeping the first nine in petdex's order is what lets one of
  // their spritesheets drop in unchanged.
  'feeding',
  'battling'
] as const;

export type PetState = (typeof PET_STATES)[number];

/**
 * What the pet is told about, as the desktop app's hook server reports it.
 *
 * The first four come from a coding agent's hooks. `game` comes from the game
 * itself — feeding a pet on the web should make the pet on your desktop react,
 * and it travels through the same endpoint so there is one way in.
 */
export type AgentEvent =
  | { kind: 'tool-start'; tool: string }
  | { kind: 'tool-end'; tool: string; ok: boolean }
  | { kind: 'prompt' }
  | { kind: 'idle' }
  | { kind: 'game'; what: 'fed' | 'battled' | 'petted' };

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
    case 'game':
      // A pet you touched should look at you, which is what `waving` is for.
      if (event.what === 'petted') return 'waving';
      return event.what === 'fed' ? 'feeding' : 'battling';
  }
}
