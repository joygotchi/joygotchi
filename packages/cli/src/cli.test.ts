import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeInstallCode } from '@joygotchi/pet';
import { DEFAULTS, resolveChain } from './chain.js';
import { PetNotFoundError, installPet, installedPets, petsRoot } from './install.js';
import { parseArgs } from './cli.js';

const chain = { network: 'testnet' as const, rpc: 'http://rpc.test', contract: 'game.test' };

/** An RPC that answers `get_pet` with whatever we hand it. */
function stubRpc(pet: unknown) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'joygotchi-cli',
        result: {
          result: Array.from(Buffer.from(JSON.stringify(pet), 'utf8'))
        }
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  );
}

describe('parseArgs', () => {
  it('reads a command, its argument and the flags around it', () => {
    const parsed = parseArgs(['install', 'jg1_06vwqsthtnk0', '--network', 'mainnet', '--json']);
    expect(parsed.command).toBe('install');
    expect(parsed.args).toEqual(['jg1_06vwqsthtnk0']);
    expect(parsed.flags.network).toBe('mainnet');
    expect(parsed.flags.json).toBe(true);
  });

  it('does not swallow the next flag as a value', () => {
    expect(() => parseArgs(['list', '--rpc'])).toThrow('--rpc needs a value');
  });

  it('rejects an unknown option instead of treating it as a pet code', () => {
    expect(() => parseArgs(['install', '--force'])).toThrow('Unknown option --force');
  });

  it('treats no arguments as a request for help', () => {
    expect(parseArgs([]).command).toBe('');
  });
});

describe('resolveChain', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to testnet, where the pets actually are right now', () => {
    expect(resolveChain({})).toEqual({ network: 'testnet', ...DEFAULTS.testnet });
  });

  it('lets a flag beat the environment, and the environment beat the default', () => {
    process.env.JOYGOTCHI_RPC = 'http://from-env';
    expect(resolveChain({}).rpc).toBe('http://from-env');
    expect(resolveChain({ rpc: 'http://from-flag' }).rpc).toBe('http://from-flag');
  });

  it('refuses a network it cannot reach rather than guessing', () => {
    expect(() => resolveChain({ network: 'regtest' })).toThrow('Unknown network');
  });
});

describe('installPet', () => {
  let home: string;
  const pet = {
    pet_id: 3,
    owner_id: 'alice.testnet',
    name: 'ANCALAGON',
    category: 'blackdragon',
    rarity: 'common',
    level: 1,
    star: 0,
    evolution_phase: 1
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'joygotchi-'));
    process.env.JOYGOTCHI_HOME = home;
  });

  afterEach(async () => {
    delete process.env.JOYGOTCHI_HOME;
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('writes what the contract said, not what the code claimed', async () => {
    vi.stubGlobal('fetch', stubRpc(pet));

    const result = await installPet(chain, 3);
    const written = JSON.parse(await readFile(join(result.directory, 'pet.json'), 'utf8'));

    expect(written.displayName).toBe('ANCALAGON');
    expect(written.chain).toEqual({ network: 'testnet', contract: 'game.test', owner: 'alice.testnet' });
    expect(written.installCode).toBe(encodeInstallCode(3));
  });

  it('copies the art next to it, once per file rather than once per state', async () => {
    vi.stubGlobal('fetch', stubRpc(pet));

    const result = await installPet(chain, 3);

    // Nine states, one drawing: nine copies would be nine identical GIFs in a
    // folder somebody is going to open.
    expect(result.files).toEqual(['pet.json', 'blackdragon/1.gif']);
    await expect(readFile(join(result.directory, 'blackdragon/1.gif'))).resolves.toBeTruthy();
  });

  it('says it replaced a pet it had already installed', async () => {
    vi.stubGlobal('fetch', stubRpc(pet));

    expect((await installPet(chain, 3)).replaced).toBe(false);
    expect((await installPet(chain, 3)).replaced).toBe(true);
  });

  it('names the contract when the pet is not there, since the code cannot', async () => {
    vi.stubGlobal('fetch', stubRpc(null));

    await expect(installPet(chain, 99)).rejects.toThrow(PetNotFoundError);
    await expect(installPet(chain, 99)).rejects.toThrow('game.test');
  });
});

describe('installedPets', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'joygotchi-'));
    process.env.JOYGOTCHI_HOME = home;
  });

  afterEach(async () => {
    delete process.env.JOYGOTCHI_HOME;
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('is empty, not an error, before anything is installed', async () => {
    await expect(installedPets()).resolves.toEqual([]);
    expect(petsRoot()).toBe(home);
  });

  it('skips a folder that is not a pet instead of failing the listing', async () => {
    vi.stubGlobal(
      'fetch',
      stubRpc({
        pet_id: 7,
        owner_id: 'bob.testnet',
        name: 'SMAUG',
        category: 'greendragon',
        rarity: 'rare',
        level: 0,
        star: 0
      })
    );
    await installPet(chain, 7);
    await mkdtemp(join(home, 'not-a-pet-'));

    const pets = await installedPets();
    expect(pets).toHaveLength(1);
    expect(pets[0]?.displayName).toBe('SMAUG');
  });
});
