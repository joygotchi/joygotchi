import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atlasFrom,
  isBundledKind,
  pngSize,
  toPetPackage,
  type Atlas,
  type ChainPet,
  type PetPackage
} from '@joygotchi/pet';
import { fetchPet, fetchSpecies, type ChainConfig } from './chain.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The art for the species this project ships.
 *
 * The two dragons come with the CLI, so installing one of them needs no CDN,
 * no registry and no second request that can fail halfway. A species
 * somebody registered on the contract cannot work that way — its drawings
 * were made after this package was built — so those are downloaded, under
 * the limits in `fetchArt`.
 */
const ART_ROOT = resolve(here, '../assets/animation');

/**
 * What a downloaded sheet is called inside the package.
 *
 * Never taken from the url. A name from a stranger is a path from a
 * stranger, and this one is joined onto a directory.
 */
const SHEET_NAME = 'spritesheet.png';

/** Most we will pull down for one drawing. A sheet is a few hundred KB. */
export const MAX_ART_BYTES = 4 * 1024 * 1024;

/** What a drawing is allowed to be. */
const ART_TYPES = ['image/gif', 'image/png', 'image/webp'];

/**
 * Fetch one drawing for a species nobody shipped.
 *
 * Everything here treats the url as what it is: a string a stranger wrote
 * into a public contract, pointing at a host of their choosing. So the
 * protocol is re-checked rather than trusted from the chain, the response is
 * capped before it is held in memory, the type has to be an image, and the
 * file is written to a path built from the species id and the phase number —
 * never from anything in the url.
 */
async function fetchArt(uri: string): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`That species' art is not a url: ${uri.slice(0, 80)}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`That species' art is not served over https: ${url.protocol}//…`);
  }

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`${url.host} answered HTTP ${response.status} for this species' art`);
  }
  // A redirect chain can end somewhere else entirely.
  if (!response.url.startsWith('https://')) {
    throw new Error("That species' art redirected off https");
  }

  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
  if (!ART_TYPES.includes(type)) {
    throw new Error(`That species' art is ${type || 'of no stated type'}, not an image`);
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_ART_BYTES) {
    throw new Error(`That species' art is ${declared} bytes, over the ${MAX_ART_BYTES} limit`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  // Checked again: `content-length` is a claim, not a measurement.
  if (body.byteLength > MAX_ART_BYTES) {
    throw new Error(`That species' art is over the ${MAX_ART_BYTES} byte limit`);
  }
  return body;
}

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

  // Built twice: the kind has to be normalised before the species can be
  // looked up, and the atlas has to be known before the package is final.
  const draft = toPetPackage(pet, { network: config.network, contract: config.contract });

  /*
   * A species this project ships is copied off disk; anything else is
   * downloaded from the url its creator registered.
   *
   * The download happens once, here, so the pet works offline afterwards and
   * the desktop app never has to load a stranger's url into its webview —
   * the file ends up under `~/.joygotchi`, which is the one place the app's
   * asset protocol is allowed to read.
   */
  const bundled = isBundledKind(draft.kind);
  const remote = bundled ? null : await fetchSpecies(config, draft.kind).catch(() => null);
  if (!bundled && !remote) {
    throw new Error(`${config.contract} knows no species "${draft.kind}"`);
  }

  let atlas: Atlas | undefined;
  let sheet: Uint8Array | undefined;

  if (remote) {
    const uri = remote.art[Math.min(draft.evolutionPhase, remote.art.length) - 1];
    if (!uri) throw new Error(`Species "${draft.kind}" has no drawing for that phase`);
    const downloaded = await fetchArt(uri);

    /*
     * Which kind of art this is, decided by looking at it rather than by
     * trusting the file name. A species registered through `joygotchi
     * submit` is a nine-row atlas; the two this project ships are GIFs; and
     * a creator can register either. A PNG that is not a valid grid is left
     * as a still image rather than refused — one drawing is what every pet
     * in this game had until today.
     */
    const size = pngSize(new Uint8Array(downloaded));
    if (size) {
      const read = atlasFrom(SHEET_NAME, size.width, size.height);
      if (read.ok) {
        atlas = read.atlas;
        sheet = new Uint8Array(downloaded);
      }
    }
    if (!atlas) sheet = new Uint8Array(downloaded);
  }

  const pkg = toPetPackage(
    pet,
    { network: config.network, contract: config.contract },
    atlas
  );
  const directory = join(petsRoot(), pkg.slug);

  const replaced = await exists(join(directory, 'pet.json'));
  await mkdir(directory, { recursive: true });

  const files = ['pet.json'];
  await writeFile(join(directory, 'pet.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  // One copy per distinct file, not per state: every state points at the
  // same sheet on a v2 package and at the same idle loop on a v1 one, and
  // writing it nine times would be nine identical files in a folder a
  // person is going to open.
  for (const asset of new Set(Object.values(pkg.states))) {
    const target = join(directory, asset);
    await mkdir(dirname(target), { recursive: true });
    if (sheet) {
      await writeFile(target, sheet);
    } else {
      await copyFile(join(ART_ROOT, asset), target);
    }
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
