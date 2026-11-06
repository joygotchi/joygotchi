import type { PetStatus, StakeAccount } from '@joygotchi/pet';

/**
 * Read the chain from the desktop app.
 *
 * Reads only. Signing needs a key, and the app does not have one yet — see
 * `PetPanel.svelte` for what that costs and why it is not a stored full-access
 * key.
 *
 * The contract ids come from the installed `pet.json` rather than from a
 * constant here, so a pet minted against a different deployment still resolves
 * against the deployment it came from.
 */
const RPC = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com'
} as const;

/** The staking contract that pairs with a given game contract. */
export const stakeContractFor = (gameContract: string) =>
  gameContract.replace(/^jg-game-/, 'jg-stake-');

export async function viewFunction<T>(
  network: string,
  contractId: string,
  method: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const url = RPC[network as keyof typeof RPC] ?? RPC.testnet;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'joygotchi-desktop',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args))
      }
    })
  });

  if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);

  const body = (await response.json()) as {
    result?: { result: number[]; error?: string };
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? 'the RPC refused the query');
  if (!body.result) throw new Error('the RPC returned nothing');
  if (body.result.error) throw new Error(body.result.error);

  const text = new TextDecoder().decode(new Uint8Array(body.result.result));
  return (text === '' ? null : JSON.parse(text)) as T;
}

export const getStakeAccount = (network: string, stake: string, accountId: string) =>
  viewFunction<StakeAccount | null>(network, stake, 'get_account', { account_id: accountId });

export const getPetStatus = (network: string, stake: string, petId: number) =>
  viewFunction<PetStatus>(network, stake, 'get_pet_state', { pet_id: petId });

export const getInventory = (network: string, stake: string, accountId: string) =>
  viewFunction<Array<[number, number]>>(network, stake, 'get_inventory', {
    account_id: accountId
  });
