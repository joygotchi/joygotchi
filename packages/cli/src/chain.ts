import type { ChainPet } from '@joygotchi/pet';

/**
 * The chain, read directly.
 *
 * The CLI deliberately talks to a NEAR RPC and nothing else: no API key, no
 * account, no registry of ours in the middle. A pet is a token on a public
 * contract, so the authority on who owns what is the contract — and an install
 * that only needs an RPC still works if this project's website is down.
 */

export type Network = 'testnet' | 'mainnet';

export const DEFAULTS = {
  testnet: {
    rpc: 'https://test.rpc.fastnear.com',
    contract: 'jg-game-5656.testnet'
  },
  mainnet: {
    rpc: 'https://free.rpc.fastnear.com',
    contract: 'game.joygotchi.near'
  }
} as const satisfies Record<Network, { rpc: string; contract: string }>;

export type ChainConfig = { network: Network; rpc: string; contract: string };

/** Config from flags, then environment, then the defaults above. */
export function resolveChain(flags: {
  network?: string;
  rpc?: string;
  contract?: string;
}): ChainConfig {
  const network = (flags.network ?? process.env.JOYGOTCHI_NETWORK ?? 'testnet') as Network;
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`Unknown network "${network}" — use testnet or mainnet`);
  }

  return {
    network,
    rpc: flags.rpc ?? process.env.JOYGOTCHI_RPC ?? DEFAULTS[network].rpc,
    contract: flags.contract ?? process.env.JOYGOTCHI_CONTRACT ?? DEFAULTS[network].contract
  };
}

type RpcResponse<T> = { result?: T; error?: { message?: string } };

async function viewFunction<T>(
  config: ChainConfig,
  method: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(config.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'joygotchi-cli',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: config.contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64')
      }
    })
  });

  if (!response.ok) {
    throw new Error(`${config.rpc} answered HTTP ${response.status}`);
  }

  const body = (await response.json()) as RpcResponse<{ result: number[]; error?: string }>;
  if (body.error) throw new Error(body.error.message ?? 'the RPC refused the query');
  if (!body.result) throw new Error('the RPC returned nothing');
  if (body.result.error) throw new Error(`${config.contract}.${method}: ${body.result.error}`);

  const text = Buffer.from(body.result.result).toString('utf8');
  return (text === '' ? null : JSON.parse(text)) as T;
}

export async function fetchPet(config: ChainConfig, petId: number): Promise<ChainPet | null> {
  return viewFunction<ChainPet | null>(config, 'get_pet', { pet_id: petId });
}

export async function fetchSupply(config: ChainConfig): Promise<number> {
  const supply = await viewFunction<string>(config, 'nft_total_supply');
  return Number(supply) || 0;
}

/** Every pet, newest first. Used by `joygotchi list`. */
export async function fetchPets(config: ChainConfig, limit: number): Promise<ChainPet[]> {
  const total = await fetchSupply(config);
  const ids: number[] = [];
  for (let id = total; id >= 1 && ids.length < limit; id--) ids.push(id);

  const pets = await Promise.all(ids.map((id) => fetchPet(config, id).catch(() => null)));
  return pets.filter((pet): pet is ChainPet => pet !== null);
}
