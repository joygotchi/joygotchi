import { GAME_CONTRACT, GAS } from '#lib/config';
import { viewFunction } from '#lib/near/rpc';

/**
 * Sprite sheets stored on chain, in `contracts/art`.
 *
 * The contract sits on a sub-account of the game contract, so its name needs
 * no setting of its own: one more environment variable is one more thing a
 * deploy can get wrong.
 */
export const ART_CONTRACT = `art.${GAME_CONTRACT}`;

/** A sheet's address: the hex SHA-256 of its bytes, as the contract keys it. */
export async function sheetHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The url a species registers for a stored sheet. */
export const sheetUrl = (origin: string, hash: string) => `${origin}/api/art/${hash}.png`;

export const isSheetHash = (hash: string) => /^[0-9a-f]{64}$/.test(hash);

/** What storing `bytes` costs, in yoctoNEAR; `put` refunds anything over. */
export async function storageCost(bytes: number): Promise<string> {
  return viewFunction<string>(ART_CONTRACT, 'storage_cost', { bytes });
}

export async function hasSheet(hash: string): Promise<boolean> {
  return viewFunction<boolean>(ART_CONTRACT, 'has', { hash }).catch(() => false);
}

/** Bytes to base64 without blowing the call stack on a 150 KB sheet. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Store a sheet through the wallet and return its hash.
 *
 * A sheet already on chain is not sent again: storing is idempotent there,
 * but the transaction would still cost a signature and gas.
 */
export async function storeSheet(bytes: Uint8Array): Promise<string> {
  const hash = await sheetHash(bytes);
  if (await hasSheet(hash)) return hash;

  const { callFunction } = await import('#lib/near/tx');
  await callFunction(
    ART_CONTRACT,
    'put',
    { sheet: toBase64(bytes) },
    { gas: GAS.heavy, deposit: await storageCost(bytes.length) }
  );
  if (!(await hasSheet(hash))) throw new Error('The sheet was sent but is not on chain yet');
  return hash;
}
