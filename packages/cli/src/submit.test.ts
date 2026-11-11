import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { SPECIES_ART_ROOT, SubmitError, prepareSubmission } from './submit.js';

/** A PNG header of the given size. Nothing here reads past it. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('prepareSubmission', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'joygotchi-species-'));
    await writeFile(
      join(folder, 'species.json'),
      JSON.stringify({ id: 'wyvern', name: 'Azure Wyvern' })
    );
    await writeFile(join(folder, '1.png'), png(1536, 1872));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('reads a species drawn on this machine and says what registering it takes', async () => {
    const found = await prepareSubmission(folder);
    expect(found.id).toBe('wyvern');
    expect(found.sheets[0]!.atlas.frame).toEqual({ width: 192, height: 208 });
    expect(found.art).toHaveLength(3);
    for (const url of found.art) expect(url.startsWith('https://')).toBe(true);
  });

  it('points every phase at one file when only one is drawn', async () => {
    /*
     * A species stores three urls because a pet that evolves should look
     * different afterwards. A creator with one drawing should not have three
     * copies of the same bytes committed on their behalf.
     */
    const found = await prepareSubmission(folder);
    expect(new Set(found.art).size).toBe(1);
    expect(new Set(found.served.map((one) => one.path)).size).toBe(1);
  });

  it('uses a later sheet from the phase it was drawn for', async () => {
    await writeFile(join(folder, '3.png'), png(1536, 1872));
    const found = await prepareSubmission(folder);

    expect(found.art[0]).toContain('/1.png');
    // Phase 2 has no sheet, so it keeps phase 1's.
    expect(found.art[1]).toContain('/1.png');
    expect(found.art[2]).toContain('/3.png');
  });

  it('refuses a sheet whose grid does not divide', async () => {
    // Before a deposit is attached, not after: registering costs NEAR.
    await writeFile(join(folder, '1.png'), png(1530, 1872));
    await expect(prepareSubmission(folder)).rejects.toThrow(SubmitError);
  });

  it('refuses an id the contract would refuse', async () => {
    await writeFile(
      join(folder, 'species.json'),
      JSON.stringify({ id: 'Azure Wyvern', name: 'Azure Wyvern' })
    );
    await expect(prepareSubmission(folder)).rejects.toThrow('cannot be a species id');
  });

  it('says what is missing rather than failing obscurely', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'joygotchi-empty-'));
    await expect(prepareSubmission(empty)).rejects.toThrow('species.json');

    await writeFile(join(empty, 'species.json'), JSON.stringify({ id: 'abc', name: 'A' }));
    await expect(prepareSubmission(empty)).rejects.toThrow('1.png');

    await rm(empty, { recursive: true, force: true });
  });

  it('refuses something that is not a PNG at all', async () => {
    await writeFile(join(folder, '1.png'), Buffer.from('GIF89a'));
    await expect(prepareSubmission(folder)).rejects.toThrow('not a PNG');
  });

  it('refuses a folder that does not exist', async () => {
    await expect(prepareSubmission(join(folder, 'nope'))).rejects.toThrow('not a folder');
  });

  describe('--into a checkout', () => {
    let checkout: string;

    beforeEach(async () => {
      checkout = await mkdtemp(join(tmpdir(), 'joygotchi-checkout-'));
      await mkdir(join(checkout, SPECIES_ART_ROOT), { recursive: true });
    });

    afterEach(async () => {
      await rm(checkout, { recursive: true, force: true });
    });

    it('writes the sheets where the site serves them from', async () => {
      const found = await prepareSubmission(folder, { into: checkout });
      expect(found.copiedTo).toContain('wyvern');

      const written = await readdir(join(checkout, SPECIES_ART_ROOT, 'wyvern'));
      expect(written).toEqual(['1.png']);
    });

    it('refuses a folder that is not a checkout, rather than creating one', async () => {
      // Otherwise a typo scatters a species art tree into a home directory.
      const elsewhere = await mkdtemp(join(tmpdir(), 'joygotchi-not-a-repo-'));
      await expect(prepareSubmission(folder, { into: elsewhere })).rejects.toThrow(
        'does not look like a joygotchi checkout'
      );
      await rm(elsewhere, { recursive: true, force: true });
    });
  });
});
