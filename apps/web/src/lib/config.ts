import {
  PUBLIC_GAME_CONTRACT,
  PUBLIC_MINT_PRICE_NEAR,
  PUBLIC_NEAR_NETWORK,
  PUBLIC_NEAR_RPC_URL,
  PUBLIC_STAKE_CONTRACT
} from '$app/env/public';

export const NETWORK = PUBLIC_NEAR_NETWORK;
export const GAME_CONTRACT = PUBLIC_GAME_CONTRACT;
export const STAKE_CONTRACT = PUBLIC_STAKE_CONTRACT;

/**
 * FastNEAR by default, and not for speed.
 *
 * `rpc.mainnet.near.org` sends no CORS header, so every view call from the
 * browser fails and balances silently read zero. The testnet archival endpoint
 * also rate-limits hard enough to break a page that reads a dozen pets.
 */
export const RPC_URL =
  PUBLIC_NEAR_RPC_URL ||
  (NETWORK === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com');

export const EXPLORER =
  NETWORK === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';

/** An account's page. */
export const explorerAccount = (accountId: string) => `${EXPLORER}/address/${accountId}`;

/** One transaction. */
export const explorerTx = (hash: string) => `${EXPLORER}/txns/${hash}`;

/**
 * The NFT token itself, which is what someone means by "the pet on the
 * explorer" — not the contract account that happens to hold it.
 */
export const explorerToken = (petId: number) =>
  `${EXPLORER}/nft-token/${GAME_CONTRACT}/${petId}`;

export const MINT_PRICE_NEAR = PUBLIC_MINT_PRICE_NEAR;

/** Gas, in units. 100 Tgas covers a call that crosses contracts twice. */
export const GAS = {
  call: '30000000000000',
  heavy: '100000000000000'
} as const;

