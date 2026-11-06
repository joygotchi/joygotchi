import { artPath, type EvolutionPhase, type PetKind } from '@joygotchi/pet';

/**
 * Art for a pet that is not installed on this machine.
 *
 * Only your own pets have a folder under `~/.joygotchi`, but a battle needs to
 * draw the other side too. The gallery serves the same files the CLI bundles,
 * so an opponent is drawn from the same art by URL — `artPath` keeps the two
 * agreeing about which drawing belongs to which kind and phase.
 */
const GALLERY = () => localStorage.getItem('joygotchi:api') ?? 'https://joygotchi.vercel.app';

export function artPathFor(pet: { kind?: string; category?: string; evolution_phase?: number }) {
  const kind = (pet.kind ?? pet.category ?? 'blackdragon') as PetKind;
  const phase = Math.min(4, Math.max(1, Math.trunc(pet.evolution_phase ?? 1))) as EvolutionPhase;
  return `${GALLERY()}/assets/animation/${artPath(kind, phase)}`;
}
