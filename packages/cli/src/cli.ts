import { decodeInstallCode, InvalidInstallCodeError, petSlug } from '@joygotchi/pet';
import { fetchPets, resolveChain } from './chain.js';
import { installedPets, installPet, PetNotFoundError, petsRoot } from './install.js';
import { prepareSubmission, SubmitError } from './submit.js';

/**
 * `joygotchi` — the catalog client.
 *
 * Deliberately small: install a pet, list what is on the chain, list what is on
 * this machine. The floating pet itself is the desktop app's job, and anything
 * that costs NEAR happens in a wallet, not here. A CLI that never holds a key
 * is a CLI nobody has to trust.
 */

const HELP = `joygotchi — install on-chain pets on your machine

Usage
  joygotchi install <code>     Install a pet from its install code
  joygotchi list               Pets on the contract
  joygotchi installed          Pets already on this machine
  joygotchi where              Where pets are installed
  joygotchi submit <folder>    Check a species you drew, and say how to register it

Options
  --network <testnet|mainnet>  Default: testnet (or JOYGOTCHI_NETWORK)
  --rpc <url>                  NEAR RPC (or JOYGOTCHI_RPC)
  --contract <account>         Game contract (or JOYGOTCHI_CONTRACT)
  --into <checkout>            submit: copy the sheets into a joygotchi checkout
  --json                       Machine-readable output
  -h, --help                   This

A species folder
  species.json                 {"id":"wyvern","name":"Azure Wyvern"}
  1.png                        8x9 sprite atlas, 1536x1872. Phase 1.
  2.png, 3.png                 Optional. Each phase falls back to the last.

Examples
  joygotchi install jg1_06vwqsthtnk0
  joygotchi list --json
  joygotchi submit ./my-wyvern
`;

type Flags = {
  network?: string;
  rpc?: string;
  contract?: string;
  json: boolean;
  help: boolean;
  limit?: number;
  into?: string;
};

export function parseArgs(argv: string[]): { command: string; args: string[]; flags: Flags } {
  const flags: Flags = { json: false, help: false };
  const args: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? '';
    switch (token) {
      case '--json':
        flags.json = true;
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '--network':
      case '--rpc':
      case '--into':
      case '--contract':
      case '--limit': {
        const value = argv[++index];
        if (value === undefined) throw new Error(`${token} needs a value`);
        if (token === '--limit') flags.limit = Number(value);
        else flags[token.slice(2) as 'network' | 'rpc' | 'contract' | 'into'] = value;
        break;
      }
      default:
        if (token.startsWith('-')) throw new Error(`Unknown option ${token}`);
        args.push(token);
    }
  }

  return { command: args[0] ?? '', args: args.slice(1), flags };
}

const dim = (text: string) => `\u001b[2m${text}\u001b[0m`;
const bold = (text: string) => `\u001b[1m${text}\u001b[0m`;
const green = (text: string) => `\u001b[32m${text}\u001b[0m`;

export async function run(argv: string[]): Promise<number> {
  const { command, args, flags } = parseArgs(argv);

  if (flags.help || command === '' || command === 'help') {
    console.log(HELP);
    return 0;
  }

  switch (command) {
    case 'install': {
      const code = args[0];
      if (!code) {
        console.error('Which pet? Copy its install code from its page.');
        return 1;
      }

      const petId = decodeInstallCode(code);
      const chain = resolveChain(flags);
      const result = await installPet(chain, petId);

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }

      const { pkg } = result;
      console.log(
        `${green(result.replaced ? 'Updated' : 'Installed')} ${bold(pkg.displayName)} ${dim(`#${pkg.petId}`)}`
      );
      console.log(`  ${dim('rarity')}  ${pkg.rarity}, level ${pkg.level}, phase ${pkg.evolutionPhase}`);
      console.log(`  ${dim('owner')}   ${pkg.chain.owner} ${dim(`on ${pkg.chain.network}`)}`);
      console.log(`  ${dim('path')}    ${result.directory}`);
      console.log();
      console.log(dim('Open the desktop app and pick it under Pets.'));
      return 0;
    }

    case 'list': {
      const chain = resolveChain(flags);
      const pets = await fetchPets(chain, flags.limit ?? 50);

      if (flags.json) {
        console.log(JSON.stringify(pets, null, 2));
        return 0;
      }

      if (pets.length === 0) {
        console.log(`No pets on ${chain.contract} yet.`);
        return 0;
      }

      console.log(dim(`${pets.length} pets on ${chain.contract}`));
      for (const pet of pets) {
        const slug = petSlug(pet);
        console.log(
          `  ${bold(pet.name.padEnd(14))} ${dim(`#${String(pet.pet_id).padEnd(4)}`)} ${pet.rarity.padEnd(10)} lv${String(pet.level).padEnd(3)} ${dim(slug)}`
        );
      }
      return 0;
    }

    case 'installed': {
      const pets = await installedPets();

      if (flags.json) {
        console.log(JSON.stringify(pets, null, 2));
        return 0;
      }

      if (pets.length === 0) {
        console.log(`Nothing in ${petsRoot()} yet. Install one with its code.`);
        return 0;
      }

      for (const pet of pets) {
        console.log(`  ${bold(pet.displayName.padEnd(14))} ${dim(pet.installCode)} ${pet.slug}`);
      }
      return 0;
    }

    case 'where':
      console.log(petsRoot());
      return 0;

    case 'submit': {
      const folder = args[0];
      if (!folder) {
        console.error('Which folder? joygotchi submit ./my-wyvern');
        return 1;
      }

      try {
        const found = await prepareSubmission(folder, { into: flags.into });

        if (flags.json) {
          console.log(JSON.stringify(found, null, 2));
          return 0;
        }

        const frame = found.sheets[0]!.atlas.frame;
        console.log(`${green('Ready')} ${bold(found.name)} ${dim(`(${found.id})`)}`);
        console.log(`  ${dim('frames')}  ${frame.width}x${frame.height}, 8 across, 9 states down`);
        for (const sheet of found.sheets) {
          console.log(`  ${dim(`phase ${sheet.phase}`)} ${sheet.atlas.sheet}`);
        }
        console.log();

        if (found.copiedTo) {
          console.log(`Copied into ${found.copiedTo}`);
          console.log(dim('Commit and push, then the art is live at the urls below.'));
        } else {
          console.log('Put the sheets in a joygotchi checkout, or rerun with --into <checkout>:');
          for (const one of found.served) console.log(`  ${one.path}`);
        }

        console.log();
        console.log('Then register it — this is the call that costs NEAR, and you sign it:');
        console.log();
        console.log(
          dim('  near contract call-function as-transaction <game-contract> create_species \\')
        );
        console.log(
          dim(`    json-args '${JSON.stringify({ id: found.id, name: found.name, art: found.art })}' \\`)
        );
        console.log(dim("    prepaid-gas '100.0 Tgas' attached-deposit '5 NEAR' \\"));
        console.log(dim('    sign-as <you> network-config testnet sign-with-keychain send'));
        return 0;
      } catch (cause) {
        if (cause instanceof SubmitError) {
          console.error(cause.message);
          return 1;
        }
        throw cause;
      }
    }

    default:
      console.error(`Unknown command "${command}". Try joygotchi --help.`);
      return 1;
  }
}
