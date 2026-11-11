import { artPath, type EvolutionPhase, type PetKind } from '@joygotchi/pet';

/**
 * Art for a pet that is not installed on this machine.
 *
 * Only your own pets have a folder under `~/.joygotchi`, but a battle needs
 * to draw the other side too. The app already ships every drawing in
 * `public/assets/animation`, so the opponent is served by the app itself.
 *
 * It used to come from the deployed gallery over https, which was wrong twice
 * over: the window's CSP allows images from `'self'`, `asset:` and `data:`
 * and nothing else, so the browser refused to load it and the opponent's half
 * of the arena was simply empty — and fetching a file that is already on disk
 * made a fight depend on the network.
 *
 * `artPath` keeps this and the CLI's bundle agreeing about which drawing
 * belongs to which kind and phase.
 */
export function artPathFor(pet: { kind?: string; category?: string; evolution_phase?: number }) {
  const kind = (pet.kind ?? pet.category ?? 'blackdragon') as PetKind;
  const phase = Math.min(4, Math.max(1, Math.trunc(pet.evolution_phase ?? 1))) as EvolutionPhase;
  return `/assets/animation/${artPath(kind, phase)}`;
}

/**
 * Where a hat sits on each drawing.
 *
 * It used to be one position in CSS — `left: 50%, top: 14%` — which is right
 * for a phase-one green dragon and wrong for every other sprite. The head
 * moves right and up with each evolution, so evolving left the hat floating
 * over a wing.
 *
 * Measured rather than guessed: the eyes are the one landmark every sprite
 * has, and the numbers below are each sprite's eye position offset by the
 * gap between the eyes and the hat on the placement that was already
 * correct. A new drawing needs a row here, and the comment above says how to
 * work one out.
 */
const HAT_ANCHORS: Record<string, Record<number, { left: number; top: number }>> = {
  greendragon: {
    1: { left: 50, top: 14 },
    2: { left: 69, top: 1 },
    3: { left: 66, top: 0 }
  },
  blackdragon: {
    1: { left: 62, top: 8 },
    2: { left: 62, top: 0 },
    3: { left: 64, top: 0 }
  }
};

/** The hat's placement for this pet, as percentages of the sprite box. */
export function hatAnchorFor(pet: {
  kind?: string;
  category?: string;
  evolution_phase?: number;
}): { left: number; top: number } {
  const kind = pet.kind ?? pet.category ?? 'blackdragon';
  const phase = Math.min(3, Math.max(1, Math.trunc(pet.evolution_phase ?? 1)));
  return HAT_ANCHORS[kind]?.[phase] ?? { left: 50, top: 14 };
}
