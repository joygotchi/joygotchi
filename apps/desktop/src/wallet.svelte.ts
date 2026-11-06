import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from 'near-api-js';
import { stakeContractFor } from './chain';

/**
 * Connecting a wallet, and signing without one afterwards.
 *
 * The browser opens exactly once. A NEAR wallet sign-in is, underneath, the
 * player's wallet adding a **function-call access key** to their account for
 * one contract — so "connect" and "grant a session key" are the same act, and
 * after it this app signs locally with no popups.
 *
 * What that key cannot do is the protocol's guarantee rather than ours: one
 * contract, the methods below, and never any attached NEAR. That last part is
 * why `stake_pet` and `unstake_pet` are missing from the list — they require
 * one yoctoNEAR precisely so that only a real wallet signature can move a pet
 * in or out of the lab.
 */

/** Everything the desktop needs, and nothing that spends what it should not. */
export const SESSION_METHODS = [
  'claim_credits',
  'spend_credits',
  'buy_credit_item',
  'use_item',
  'claim_mining',
  'claim_faucet'
] as const;

/**
 * Deliberately absent: `list_item` and `buy_listing`. A key that can sell
 * your items at a price it chooses is a key that can empty your inventory,
 * and nothing on the desktop needs to trade.
 */

export const SESSION_DAYS = 30;

/**
 * The gallery brokers the wallet, rather than one wallet being wired in here.
 *
 * This used to link straight at MyNearWallet, which announced its shutdown for
 * 31 October 2026 — a desktop app wired to one wallet's redirect scheme dies
 * with that wallet. `/connect` on the site puts a selector in front instead,
 * so HOT, Meteor or whatever comes next all work without this file changing.
 *
 * Override it for a local gallery with
 * `localStorage.setItem('joygotchi:api', 'http://localhost:5173')`.
 */
const SITE = () => localStorage.getItem('joygotchi:api') ?? 'https://joygotchi.vercel.app';

const RPC_URL = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com'
} as const;

export type Session = {
  accountId: string;
  publicKey: string;
  contractId: string;
  methodNames: string[];
  /** Unix seconds; 0 means never. */
  expiresAt: number;
};

const network = (value: string) => (value === 'mainnet' ? 'mainnet' : 'testnet');

/**
 * Build the sign-in URL and hand it to the system browser.
 *
 * The keypair is generated here because the wallet needs the public half in
 * the URL — it is adding *our* key to the player's account, not handing us
 * one of theirs. The secret is kept until the wallet reports back; storing it
 * before then would leave a key on disk for an account that never granted it.
 */
export async function beginConnect(gameContract: string) {
  const keyPair = KeyPair.fromRandom('ed25519');
  const contractId = stakeContractFor(gameContract);
  const callback = await invoke<string>('wallet_callback_url');

  const url = new URL('/connect', SITE());
  url.searchParams.set('public_key', keyPair.getPublicKey().toString());
  url.searchParams.set('contract_id', contractId);
  url.searchParams.set('methods', SESSION_METHODS.join(','));
  url.searchParams.set('callback', callback);

  await invoke('open_url', { url: url.toString() });

  return { keyPair, contractId };
}

/** Called once the wallet redirects back with the account it granted for. */
export async function completeConnect(
  pending: { keyPair: KeyPair; contractId: string },
  accountId: string
): Promise<Session> {
  const session: Session = {
    accountId,
    publicKey: pending.keyPair.getPublicKey().toString(),
    contractId: pending.contractId,
    methodNames: [...SESSION_METHODS],
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400
  };

  await invoke('save_session', {
    session,
    secretKey: pending.keyPair.toString()
  });

  return session;
}

/**
 * The connect flow, owned by the module rather than by a panel.
 *
 * A wallet grant is a round trip through the browser, and it outlives any
 * window the player happens to have open. When this state lived in
 * `Settings.svelte`, closing the panel while the browser was open threw away
 * both the keypair and the listener — so the grant succeeded, the callback
 * fired into nothing, and the app went on offering "Connect wallet".
 */
export const session = $state<{ current: Session | null; connecting: boolean; error: string | null }>(
  { current: null, connecting: false, error: null }
);

let pending: { keyPair: KeyPair; contractId: string } | null = null;
let listening = false;

export const getSession = () => invoke<Session | null>('get_session');
export const clearSession = async () => {
  await invoke('clear_session');
  session.current = null;
};

/** Register the callback listeners once, for as long as the app runs. */
export async function watchConnect() {
  if (listening) return;
  listening = true;

  session.current = await getSession();

  await listen<{ accountId: string }>('wallet-connected', async (event) => {
    if (!pending) {
      // The grant landed with no keypair waiting for it. Nothing can be done
      // with it, and saying so beats a button that silently does nothing.
      session.connecting = false;
      session.error = 'A wallet granted a key, but this app had stopped waiting. Try again.';
      return;
    }

    try {
      session.current = await completeConnect(pending, event.payload.accountId);
      session.error = null;
    } catch (cause) {
      session.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      pending = null;
      session.connecting = false;
    }
  });

  await listen('wallet-cancelled', () => {
    pending = null;
    session.connecting = false;
    session.error = 'The wallet did not grant anything.';
  });
}

/** Start a connect. The result arrives through `watchConnect`. */
export async function connect(gameContract: string) {
  session.connecting = true;
  session.error = null;
  try {
    pending = await beginConnect(gameContract);
  } catch (cause) {
    session.connecting = false;
    session.error = cause instanceof Error ? cause.message : String(cause);
  }
}

export const sessionExpired = (session: Session, nowSecs = Math.floor(Date.now() / 1000)) =>
  session.expiresAt !== 0 && nowSecs >= session.expiresAt;

export class NoSessionError extends Error {
  constructor() {
    super('Connect a wallet first');
    this.name = 'NoSessionError';
  }
}

export class MethodNotInSessionError extends Error {
  constructor(method: string) {
    super(`This app's key cannot call ${method} — it needs your wallet`);
    this.name = 'MethodNotInSessionError';
  }
}

/**
 * Sign one function call with the session key and send it.
 *
 * The method is checked against the session before anything is signed. The
 * chain would reject it anyway, but it would do so after a round trip and
 * with a message about access keys rather than about what the player did.
 */
export async function signAndSend(
  net: string,
  method: string,
  args: Record<string, unknown>,
  gas = 100_000_000_000_000n
): Promise<string> {
  const session = await getSession();
  if (!session) throw new NoSessionError();
  if (sessionExpired(session)) throw new Error('This session has expired — connect again');
  if (!session.methodNames.includes(method)) throw new MethodNotInSessionError(method);

  const secret = await invoke<string | null>('session_secret_key');
  if (!secret) throw new NoSessionError();

  const keyPair = KeyPair.fromString(secret as Parameters<typeof KeyPair.fromString>[0]);
  const provider = new JsonRpcProvider({ url: RPC_URL[network(net)] });
  const account = new Account(session.accountId, provider, new KeyPairSigner(keyPair));

  // `callFunction` fetches the key's own nonce and a recent block hash, signs
  // and sends. Hand-rolling that is borsh plus ed25519 plus nonce handling,
  // and getting any of the three subtly wrong fails at the chain rather than
  // here.
  //
  // No deposit, ever: a function-call key cannot attach one, so passing a
  // non-zero value would produce a transaction the protocol refuses.
  const outcome = await account.callFunction({
    contractId: session.contractId,
    methodName: method,
    args,
    gas,
    deposit: 0n
  });

  return describeOutcome(outcome);
}

/**
 * Read the result, and treat a failed receipt as a failure.
 *
 * A NEAR transaction reports success as soon as its first receipt is accepted,
 * so a check inside a cross-contract callback fails silently from here — the
 * same trap the web app hit, worth closing in both places.
 */
function describeOutcome(outcome: unknown): string {
  const result = outcome as {
    transaction?: { hash?: string };
    status?: unknown;
    receipts_outcome?: Array<{ outcome: { status?: unknown } }>;
  };

  for (const status of [result.status, ...(result.receipts_outcome ?? []).map((r) => r.outcome.status)]) {
    const message = panicMessage(status);
    if (message) throw new Error(message);
  }
  return result.transaction?.hash ?? '';
}

/** Pull the contract's own words out of a failure, not the envelope's. */
function panicMessage(status: unknown): string | null {
  const kind = (status as { Failure?: { ActionError?: { kind?: Record<string, unknown> } } })
    ?.Failure?.ActionError?.kind;
  if (!kind) return null;

  const execution = (kind as { FunctionCallError?: { ExecutionError?: string } }).FunctionCallError
    ?.ExecutionError;
  if (typeof execution === 'string') {
    return execution.replace(/^Smart contract panicked:\s*/, '');
  }
  return Object.keys(kind)[0] ?? 'the call failed';
}
