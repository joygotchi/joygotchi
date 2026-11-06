import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { GAME_METHODS, STAKE_METHODS, contractForMethod } from '@joygotchi/pet';
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

/**
 * The two keys a session needs, because a function-call key is bound to one
 * contract: the lab for credits and items, the game for fighting and evolving.
 * The lists live in `@joygotchi/pet` so the gallery grants exactly what the
 * app will try to call.
 */
export const SESSION_METHODS = [...STAKE_METHODS, ...GAME_METHODS] as const;

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
  /** The lab. Kept under its old name so an existing session still loads. */
  contractId: string;
  /** The game contract, granted alongside it. Absent on older sessions. */
  gameContractId?: string;
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
  url.searchParams.set('methods', STAKE_METHODS.join(','));
  // The same public key, granted twice: once per contract, because that is
  // the only shape NEAR allows.
  url.searchParams.set('game_contract_id', gameContract);
  url.searchParams.set('game_methods', GAME_METHODS.join(','));
  url.searchParams.set('callback', callback);

  await invoke('open_url', { url: url.toString() });

  return { keyPair, contractId, gameContract };
}

/** Called once the wallet redirects back with the account it granted for. */
export async function completeConnect(
  pending: { keyPair: KeyPair; contractId: string; gameContract: string },
  accountId: string
): Promise<Session> {
  const session: Session = {
    accountId,
    publicKey: pending.keyPair.getPublicKey().toString(),
    contractId: pending.contractId,
    gameContractId: pending.gameContract,
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

let pending: { keyPair: KeyPair; contractId: string; gameContract: string } | null = null;
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

  await listen<{ method: string; txHash: string }>('act-done', (event) => {
    walletAction.running = null;
    walletAction.done = event.payload.method;
  });

  await listen<{ method: string; error: string }>('act-failed', (event) => {
    walletAction.running = null;
    walletAction.error = event.payload.error;
  });

  await listen('wallet-cancelled', () => {
    pending = null;
    session.connecting = false;
    session.error = 'The wallet did not grant anything.';
  });
}

/**
 * One wallet-signed action, for the things a session key may not do.
 *
 * `stake_pet` and `unstake_pet` require a yoctoNEAR, and a function-call key
 * can never attach one — that requirement is the contract asking for a real
 * signature. So these go out to the gallery and come back over loopback, the
 * same path a grant takes.
 */
/**
 * What the player just did to their pet, for the window to act out.
 *
 * The pet already animates for a coding agent's hooks; doing the same for a
 * feed or a fight is the same vocabulary pointed at the game, and it is why
 * `feeding` and `battling` were added to the state list.
 */
export const petReaction = $state<{ what: 'fed' | 'battled' | null; at: number }>({
  what: null,
  at: 0
});

export const reactToGame = (what: 'fed' | 'battled') => {
  petReaction.what = what;
  petReaction.at = Date.now();
};

export const walletAction = $state<{ running: string | null; error: string | null; done: string | null }>(
  { running: null, error: null, done: null }
);

export async function requestWalletAction(
  method: 'stake_pet' | 'unstake_pet',
  contractId: string,
  petId: number
) {
  walletAction.running = method;
  walletAction.error = null;
  walletAction.done = null;

  const callback = await invoke<string>('wallet_callback_url');
  const url = new URL('/act', SITE());
  url.searchParams.set('method', method);
  url.searchParams.set('contract', contractId);
  url.searchParams.set('pet_id', String(petId));
  url.searchParams.set('callback', callback.replace('/wallet-callback', '/act-callback'));

  try {
    await invoke('open_url', { url: url.toString() });
  } catch (cause) {
    walletAction.running = null;
    walletAction.error = cause instanceof Error ? cause.message : String(cause);
  }
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
): Promise<{ hash: string; logs: string[] }> {
  const session = await getSession();
  if (!session) throw new NoSessionError();
  if (sessionExpired(session)) throw new Error('This session has expired — connect again');
  if (!session.methodNames.includes(method)) throw new MethodNotInSessionError(method);

  const secret = await invoke<string | null>('session_secret_key');
  if (!secret) throw new NoSessionError();

  const receiver = contractForMethod(method, {
    stake: session.contractId,
    game: session.gameContractId ?? ''
  });
  if (!receiver) {
    throw new MethodNotInSessionError(method);
  }

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
    contractId: receiver,
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
function describeOutcome(outcome: unknown): { hash: string; logs: string[] } {
  const result = outcome as {
    transaction?: { hash?: string };
    status?: unknown;
    receipts_outcome?: Array<{ outcome: { status?: unknown; logs?: string[] } }>;
  };

  for (const status of [result.status, ...(result.receipts_outcome ?? []).map((r) => r.outcome.status)]) {
    const message = panicMessage(status);
    if (message) throw new Error(message);
  }

  // A battle only says who won in its events, so the logs come back with the
  // hash rather than being thrown away.
  return {
    hash: result.transaction?.hash ?? '',
    logs: (result.receipts_outcome ?? []).flatMap((r) => r.outcome.logs ?? [])
  };
}

/** Pull one NEP-297 event out of a transaction's logs. */
export function findEvent<T = Record<string, unknown>>(
  logs: string[],
  event: string
): T | null {
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      const parsed = JSON.parse(line.slice('EVENT_JSON:'.length)) as {
        event?: string;
        data?: T[];
      };
      if (parsed.event === event && parsed.data?.[0]) return parsed.data[0];
    } catch {
      // A malformed line is the contract's problem, not the window's.
    }
  }
  return null;
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
