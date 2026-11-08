import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ACCESSORY_METHODS,
  GAME_METHODS,
  STAKE_METHODS,
  contractForMethod,
  slotForMethod
} from '@joygotchi/pet';
import {
  Account,
  FailoverRpcProvider,
  JsonRpcProvider,
  KeyPair,
  PublicKey,
  Signer
} from 'near-api-js';
import { accessoryContractFor, stakeContractFor } from './chain';

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
 * why `list_pet`, `buy_pet` and `nft_transfer` are missing from the list —
 * they are payable precisely so that only a real wallet signature can part a
 * player from a pet or from NEAR
 * in or out of the lab.
 */

/**
 * The two keys a session needs, because a function-call key is bound to one
 * contract: the lab for credits and items, the game for fighting and evolving.
 * The lists live in `@joygotchi/pet` so the gallery grants exactly what the
 * app will try to call.
 */
export const SESSION_METHODS = [
  ...STAKE_METHODS,
  ...GAME_METHODS,
  ...ACCESSORY_METHODS
] as const;

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

/**
 * More than one node per network, in preference order.
 *
 * Signing used to go to a single public endpoint with nothing behind it, so
 * a rate limit there came back to the player as WebKit's `Load failed` on
 * whatever button they pressed — a message that says nothing about what went
 * wrong or whether their pet was fed.
 */
const RPC_URL = {
  testnet: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org']
} as const;

export type Session = {
  accountId: string;
  publicKey: string;
  /** The lab. Kept under its old name so an existing session still loads. */
  contractId: string;
  /** The game contract, reached by its own key. Absent on older sessions. */
  gameContractId?: string;
  /**
   * The game key's public half.
   *
   * A second keypair, not the same one granted twice: NEAR stores access keys
   * as a map from public key to permission, so one public key carries exactly
   * one contract. Granting it again for another contract does nothing, and
   * does it silently — `attack` failed with "access key receiver
   * jg-stake-… does not match transaction receiver jg-game-…" until this
   * became two keys.
   */
  gamePublicKey?: string;
  accessoryContractId?: string;
  accessoryPublicKey?: string;
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
  // Three keypairs for three contracts. A NEAR account's access keys are a
  // map from public key to permission, so one key can only ever name one
  // contract — granting the same key twice silently does nothing.
  const keyPair = KeyPair.fromRandom('ed25519');
  const gameKeyPair = KeyPair.fromRandom('ed25519');
  const accessoryKeyPair = KeyPair.fromRandom('ed25519');
  const contractId = stakeContractFor(gameContract);
  const accessoryContract = accessoryContractFor(gameContract);
  const callback = await invoke<string>('wallet_callback_url');

  const url = new URL('/connect', SITE());
  url.searchParams.set('public_key', keyPair.getPublicKey().toString());
  url.searchParams.set('contract_id', contractId);
  url.searchParams.set('methods', STAKE_METHODS.join(','));
  // A different public key: one key cannot hold two contracts' permissions.
  url.searchParams.set('game_public_key', gameKeyPair.getPublicKey().toString());
  url.searchParams.set('game_contract_id', gameContract);
  url.searchParams.set('game_methods', GAME_METHODS.join(','));
  url.searchParams.set('accessory_public_key', accessoryKeyPair.getPublicKey().toString());
  url.searchParams.set('accessory_contract_id', accessoryContract);
  url.searchParams.set('accessory_methods', ACCESSORY_METHODS.join(','));
  url.searchParams.set('callback', callback);

  await invoke('open_url', { url: url.toString() });

  return { keyPair, gameKeyPair, accessoryKeyPair, contractId, gameContract, accessoryContract };
}

/** Called once the wallet redirects back with the account it granted for. */
export async function completeConnect(
  pending: {
    keyPair: KeyPair;
    gameKeyPair: KeyPair;
    accessoryKeyPair: KeyPair;
    contractId: string;
    gameContract: string;
    accessoryContract: string;
  },
  accountId: string
): Promise<Session> {
  const session: Session = {
    accountId,
    publicKey: pending.keyPair.getPublicKey().toString(),
    contractId: pending.contractId,
    gameContractId: pending.gameContract,
    gamePublicKey: pending.gameKeyPair.getPublicKey().toString(),
    accessoryContractId: pending.accessoryContract,
    accessoryPublicKey: pending.accessoryKeyPair.getPublicKey().toString(),
    methodNames: [...SESSION_METHODS],
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400
  };

  await invoke('save_session', {
    session,
    secretKey: pending.keyPair.toString(),
    gameSecretKey: pending.gameKeyPair.toString(),
    accessorySecretKey: pending.accessoryKeyPair.toString()
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

type Pending = {
  keyPair: KeyPair;
  gameKeyPair: KeyPair;
  accessoryKeyPair: KeyPair;
  contractId: string;
  gameContract: string;
  accessoryContract: string;
};

/**
 * Keyed by public key, not a single slot.
 *
 * Pressing Connect twice used to overwrite the keypair waiting for the wallet,
 * so a grant coming back for the *first* attempt was saved against the
 * *second* pair — a session holding keys that were never granted, and an
 * `attack` failing with no sign of why. The callback carries the public key
 * the wallet actually signed for, so the right pair can be found whichever
 * attempt answers first.
 */
const pending = new Map<string, Pending>();
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

  await listen<{ accountId: string; publicKey: string }>('wallet-connected', async (event) => {
    const waiting = pending.get(event.payload.publicKey);
    if (!waiting) {
      session.connecting = false;

      // The same grant delivered twice is not a failure. It happened by
      // design once — the gallery both fetched and navigated — and reporting
      // it as an error on a connect that worked is worse than saying nothing.
      if (session.current?.publicKey === event.payload.publicKey) return;

      // A grant for a key this app does not hold. Saving the session anyway is
      // what produced keys on disk that were never on chain.
      session.error =
        'A wallet granted a key this app was not waiting for. Press Connect and finish in one go.';
      return;
    }

    try {
      session.current = await completeConnect(waiting, event.payload.accountId);
      session.error = null;
    } catch (cause) {
      session.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      pending.clear();
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
    pending.clear();
    session.connecting = false;
    session.error = 'The wallet did not grant anything.';
  });
}

/**
 * One wallet-signed action, over the browser and back through loopback.
 *
 * Staking no longer needs this: the contract dropped its yoctoNEAR, so the
 * session key carries it. What still needs it is a session granted before
 * that change — a function-call key's method list is fixed when the key is
 * made, so those sessions can never call staking and nothing but a new grant
 * will change that. They take this path instead of failing.
 */
/**
 * What the player just did to their pet, for the window to act out.
 *
 * The pet already animates for a coding agent's hooks; doing the same for a
 * feed or a fight is the same vocabulary pointed at the game, and it is why
 * `feeding` and `battling` were added to the state list.
 */
export const petReaction = $state<{ what: 'fed' | 'battled' | 'petted' | null; at: number }>({
  what: null,
  at: 0
});

export const reactToGame = (what: 'fed' | 'battled' | 'petted') => {
  petReaction.what = what;
  petReaction.at = Date.now();
};

export const walletAction = $state<{ running: string | null; error: string | null; done: string | null }>(
  { running: null, error: null, done: null }
);

/**
 * The accessory contract's calls, over the same browser round trip.
 *
 * A separate entry point rather than more optional parameters on
 * `requestWalletAction`: that one is about a pet on the staking or game
 * contract, and three of the four arguments here would be unused by it.
 */
export async function requestAccessoryAction(
  method: 'mint' | 'equip' | 'unequip',
  contractId: string,
  petId: number,
  args: { kind?: string; token_id?: string }
) {
  walletAction.running = method;
  walletAction.error = null;
  walletAction.done = null;

  const callback = await invoke<string>('wallet_callback_url');
  const url = new URL('/act', SITE());
  url.searchParams.set('method', method);
  url.searchParams.set('contract', contractId);
  url.searchParams.set('pet_id', String(petId));
  if (args.kind) url.searchParams.set('kind', args.kind);
  if (args.token_id) url.searchParams.set('token_id', args.token_id);
  url.searchParams.set('callback', callback.replace('/wallet-callback', '/act-callback'));

  try {
    await invoke('open_url', { url: url.toString() });
  } catch (cause) {
    walletAction.running = null;
    walletAction.error = cause instanceof Error ? cause.message : String(cause);
  }
}

export async function requestWalletAction(
  method: 'stake_pet' | 'unstake_pet' | 'buy_item',
  contractId: string,
  petId: number,
  itemId?: number
) {
  walletAction.running = method;
  walletAction.error = null;
  walletAction.done = null;

  const callback = await invoke<string>('wallet_callback_url');
  const url = new URL('/act', SITE());
  url.searchParams.set('method', method);
  url.searchParams.set('contract', contractId);
  url.searchParams.set('pet_id', String(petId));
  // Which item, not what it costs: the page reads the price off the contract,
  // so a link can choose the purchase but never the amount.
  if (itemId !== undefined) url.searchParams.set('item_id', String(itemId));
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
    const started = await beginConnect(gameContract);
    pending.set(started.keyPair.getPublicKey().toString(), started);
  } catch (cause) {
    session.connecting = false;
    session.error = cause instanceof Error ? cause.message : String(cause);
  }
}

export const sessionExpired = (session: Session, nowSecs = Math.floor(Date.now() / 1000)) =>
  session.expiresAt !== 0 && nowSecs >= session.expiresAt;

/**
 * A signer whose key lives in the operating system's keychain.
 *
 * `near-api-js` builds the transaction and borsh-encodes it; the only thing it
 * asks of a signer is a signature over the bytes, which goes to Rust. So the
 * secret never enters the webview at all — not at startup, not at signing
 * time. That is what keeping it out of `localStorage` is *for*: localStorage
 * is a file any process running as this user can read, and anything executing
 * inside the window can read it in one line, whereas this key is reachable
 * only through a command.
 */
class KeychainSigner extends Signer {
  constructor(
    private readonly publicKey: string,
    private readonly slot: string
  ) {
    super();
  }

  async getPublicKey(): Promise<PublicKey> {
    return PublicKey.fromString(this.publicKey);
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const signature = await invoke<number[]>('sign_bytes', {
      message: Array.from(bytes),
      slot: this.slot
    });
    return new Uint8Array(signature);
  }
}

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

  const receiver = contractForMethod(method, {
    stake: session.contractId,
    game: session.gameContractId ?? '',
    accessory: session.accessoryContractId
  });
  if (!receiver) {
    throw new MethodNotInSessionError(method);
  }

  // The key has to match the contract, not just the method: a transaction
  // signed by the lab key and sent to another contract is refused by the
  // node, not by the contract. Three contracts, three keys, one name each.
  const slot = slotForMethod(method) ?? 'lab';
  const publicKey =
    slot === 'game'
      ? session.gamePublicKey
      : slot === 'accessory'
        ? session.accessoryPublicKey
        : session.publicKey;

  if (!publicKey || !(await invoke<boolean>('has_session_key', { slot }))) {
    throw new Error(
      slot === 'lab'
        ? 'Connect a wallet first'
        : `This session has no key for the ${slot} contract — connect again to grant one`
    );
  }

  // Falls through to the next node rather than failing the transaction.
  const provider = new FailoverRpcProvider(
    RPC_URL[network(net)].map((url) => new JsonRpcProvider({ url }))
  );
  const account = new Account(
    session.accountId,
    provider,
    new KeychainSigner(publicKey, slot)
  );

  // `callFunctionRaw`, not `callFunction`: the latter returns the method's
  // decoded return value, and `attack` returns a promise, so it hands back an
  // empty object. Everything below — the receipt walk, the battle result, the
  // transaction hash — was reading that empty object and finding nothing,
  // which meant a failed receipt went unnoticed by the very code written to
  // notice it.
  //
  // No deposit, ever: a function-call key cannot attach one, so passing a
  // non-zero value would produce a transaction the protocol refuses.
  const outcome = await account.callFunctionRaw({
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

/**
 * Strip the boilerplate off whatever went wrong.
 *
 * `near-api-js` throws a `ContractExecutionError` for a panic in the outer
 * call rather than returning an outcome, so the receipt walk never sees it
 * and the message arrives with "Smart contract panicked:" still on the front.
 */
export function readableError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Smart contract panicked:\s*/, '');
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
