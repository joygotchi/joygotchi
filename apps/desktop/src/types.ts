import type { Atlas, PetState } from '@joygotchi/pet';

/** What `list_pets` returns: the pet package plus where it lives on disk. */
export type InstalledPet = {
  format: string;
  slug: string;
  displayName: string;
  petId: number;
  installCode: string;
  kind: string;
  rarity: string;
  level: number;
  star: number;
  chain: { network: string; contract: string; owner: string };
  states: Partial<Record<PetState, string>>;
  directory: string;
  /**
   * Present on a v2 package: a nine-row sprite atlas, so the pet really
   * animates per state instead of being moved around in CSS.
   */
  atlas?: Atlas;
  spriteVersion?: 1 | 2;
};
