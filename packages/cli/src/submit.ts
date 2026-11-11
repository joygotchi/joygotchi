import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { atlasFrom, pngSize, type Atlas } from '@joygotchi/pet';

/**
 * Prepare a species made on this machine for registration.
 *
 * petdex's shape, because it is the right one: you draw the pet somewhere
 * else — their Hatch Pet skill, Aseprite, anything that exports a grid —
 * and the command's job is to check it and tell you exactly what to do
 * next. It never holds a key, so it cannot register anything itself; what
 * it produces is a validated folder and the one call that registers it.
 *
 * A species is three sheets, one per evolution phase, because the contract
 * stores three urls and a pet that evolves should look different afterwards.
 * Two and three are optional: a creator with one drawing gets it used for
 * all three, which is what every pet in this game does today anyway.
 */

/** What the creator writes next to their sheets. */
export type SpeciesManifest = {
  id: string;
  name: string;
};

export type SubmitResult = {
  id: string;
  name: string;
  /**
   * One per phase, 1–3. A phase with no sheet of its own reuses the last
   * one — `drawnFor` says which phase the file was actually drawn for, so
   * the same drawing is stored once and pointed at three times rather than
   * copied three times.
   */
  sheets: { phase: number; drawnFor: number; source: string; atlas: Atlas }[];
  /** Where each sheet has to land in the repository, served path first. */
  served: { phase: number; path: string; url: string }[];
  /** The exact `art` array `create_species` takes. */
  art: string[];
  /** Set when `--into` copied the sheets into a checkout. */
  copiedTo?: string;
};

export class SubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmitError';
  }
}

/** Where a submitted sheet is served from, once the repository has it. */
export const SPECIES_ART_ROOT = 'apps/web/static/species';
export const SPECIES_ART_ORIGIN = 'https://joygotchi.vercel.app';

const PHASES = [1, 2, 3] as const;

async function readManifest(folder: string): Promise<SpeciesManifest> {
  const path = join(folder, 'species.json');
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) {
    throw new SubmitError(
      `No species.json in ${folder}. It needs {"id":"wyvern","name":"Azure Wyvern"}.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SubmitError(`${path} is not valid JSON`);
  }

  const manifest = parsed as Partial<SpeciesManifest>;
  if (typeof manifest.id !== 'string' || typeof manifest.name !== 'string') {
    throw new SubmitError(`${path} needs an "id" and a "name"`);
  }
  // The contract's rule, checked here so a creator finds out before paying.
  if (!/^[a-z0-9]{3,24}$/.test(manifest.id)) {
    throw new SubmitError(
      `"${manifest.id}" cannot be a species id: 3–24 lowercase letters and digits.`
    );
  }
  if (manifest.name.trim() === '') throw new SubmitError('A species needs a name');

  return { id: manifest.id, name: manifest.name.trim().slice(0, 32) };
}

/**
 * Check a folder and say what registering it would take.
 *
 * Reads nothing from the chain and writes nothing unless `into` is given,
 * so it is safe to run on a folder you are still working on.
 */
export async function prepareSubmission(
  folder: string,
  options: { into?: string } = {}
): Promise<SubmitResult> {
  const root = resolve(folder);
  const directory = await stat(root).catch(() => null);
  if (!directory?.isDirectory()) throw new SubmitError(`${root} is not a folder`);

  const manifest = await readManifest(root);

  const sheets: SubmitResult['sheets'] = [];
  for (const phase of PHASES) {
    // `1.png` is required; later phases fall back to the last one found.
    const candidate = join(root, `${phase}.png`);
    const bytes = await readFile(candidate).catch(() => null);

    if (bytes === null) {
      const previous = sheets[sheets.length - 1];
      if (!previous) {
        throw new SubmitError(
          `No ${basename(candidate)} in ${root}. A species needs at least one sheet, for phase 1.`
        );
      }
      sheets.push({ ...previous, phase });
      continue;

    }

    const size = pngSize(new Uint8Array(bytes));
    if (!size) throw new SubmitError(`${candidate} is not a PNG`);

    const read = atlasFrom(`${phase}.png`, size.width, size.height);
    if (!read.ok) throw new SubmitError(`${candidate}: ${read.why}`);

    sheets.push({ phase, drawnFor: phase, source: candidate, atlas: read.atlas });
  }

  const served = sheets.map((sheet) => ({
    phase: sheet.phase,
    // Named for the phase it was drawn for, not the phase it is used at, so
    // one drawing used for all three is one file with three urls pointing
    // at it rather than three copies of the same bytes.
    path: `${SPECIES_ART_ROOT}/${manifest.id}/${sheet.drawnFor}.png`,
    // `static/` is the served root, so it is not part of the url.
    url: `${SPECIES_ART_ORIGIN}/species/${manifest.id}/${sheet.drawnFor}.png`
  }));

  const result: SubmitResult = {
    id: manifest.id,
    name: manifest.name,
    sheets,
    served,
    art: served.map((one) => one.url)
  };

  if (options.into) {
    const checkout = resolve(options.into);
    const target = join(checkout, SPECIES_ART_ROOT, manifest.id);
    const web = await stat(join(checkout, SPECIES_ART_ROOT)).catch(() => null);
    if (!web?.isDirectory()) {
      throw new SubmitError(
        `${checkout} does not look like a joygotchi checkout — no ${SPECIES_ART_ROOT}/`
      );
    }

    await mkdir(target, { recursive: true });
    for (const sheet of sheets) {
      if (sheet.drawnFor !== sheet.phase) continue;
      await copyFile(sheet.source, join(target, `${sheet.drawnFor}.png`));
    }
    result.copiedTo = target;
  }

  return result;
}
