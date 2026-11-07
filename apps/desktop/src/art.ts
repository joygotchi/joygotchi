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
