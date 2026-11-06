import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPetPackage, type ChainPet, type PetPackage } from '@joygotchi/pet';
import { fetchPet, type ChainConfig } from './chain.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The art ships inside this package.
 *
 * petdex downloads spritesheets because its pets are community submissions; a
 * JOYGOTCHI pet's art is one of six drawings that come with the game, and the
 * chain only decides which. Bundling them means `install` needs no CDN, no
 * registry and no second request that can fail halfway.
 */
const ART_ROOT = resolve(here, '../assets/animation');

/** Where pets live. Overridable mostly so the tests do not touch `$HOME`. */
export function petsRoot(): string {
  return process.env.JOYGOTCHI_HOME ?? join(homedir(), '.joygotchi', 'pets');
}

export type InstallResult = {
  pkg: PetPackage;
  directory: string;
  /** Files written, relative to the pet's directory. */
  files: string[];
  /** True when a pet of this slug was already there and got replaced. */
  replaced: boolean;
};

export class PetNotFoundError extends Error {
  constructor(petId: number, contract: string) {
    super(`No pet ${petId} on ${contract}. Check the network, or the code came from another one.`);
    this.name = 'PetNotFoundError';
  }
}

/**
 * Install the pet an id points at.
 *
 * The code only carries the id; everything written to disk comes from the
 * contract, so a code cannot describe a pet into existence or claim a rarity
 * its token does not have.
 */
export async function installPet(config: ChainConfig, petId: number): Promise<InstallResult> {
  const pet = await fetchPet(config, petId);
  if (!pet) throw new PetNotFoundError(petId, config.contract);

  const pkg = toPetPackage(pet, { network: config.network, contract: config.contract });
  const directory = join(petsRoot(), pkg.slug);

  const replaced = await exists(join(directory, 'pet.json'));
  await mkdir(directory, { recursive: true });

  const files = ['pet.json'];
  await writeFile(join(directory, 'pet.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  // One copy per distinct file, not per state: all nine states point at the
  // same idle loop today, and writing it nine times would be nine identical
  // GIFs in a folder a person is going to open.
  for (const asset of new Set(Object.values(pkg.states))) {
    const source = join(ART_ROOT, asset);
    const target = join(directory, asset);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    files.push(asset);
  }

  return { pkg, directory, files, replaced };
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Pets already on this machine, read back from disk. */
export async function installedPets(): Promise<PetPackage[]> {
  const root = petsRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  const packages: PetPackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(join(root, entry.name, 'pet.json'), 'utf8');
      const parsed = JSON.parse(raw) as PetPackage;
      if (parsed.format === 'joygotchi/1') packages.push(parsed);
    } catch {
      // A folder that is not a pet, or a half-written one. Skip it rather than
      // fail the whole listing.
    }
  }
  return packages.sort((a, b) => a.petId - b.petId);
}

/** Re-read a pet off the chain and rewrite it, for a pet that levelled up. */
export async function refreshPet(
  config: ChainConfig,
  pkg: Pick<PetPackage, 'petId'>
): Promise<InstallResult> {
  return installPet(config, pkg.petId);
}

export type { ChainPet };
