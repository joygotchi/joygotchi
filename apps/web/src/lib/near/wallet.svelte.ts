import { NETWORK } from '#lib/config';

/**
 * Wallet connection, as a rune store.
 *
 * `@hot-labs/near-connect` is a modal over several wallets rather than one
 * wallet's SDK, which is what makes "log in with web3" a single button here:
 * HOT and Meteor cover mobile and extension, MyNearWallet covers the web.
 *
 * The connector is created lazily and only in the browser — it reaches for
 * `window` on construction, so importing this module during SSR would break
 * the whole page.
 */

export type WalletState = {
  accountId: string | null;
  walletId: string | null;
  connecting: boolean;
  /** Set once the connector has reported whatever session it restored. */
  ready: boolean;
  error: string | null;
};

export const wallet = $state<WalletState>({
  accountId: null,
  walletId: null,
  connecting: false,
  ready: false,
  error: null
});

/** The shape of near-connect we rely on, so its types stay out of ours. */
type Connector = {
  on: (event: string, handler: (payload: unknown) => void) => void;
  connect: (options?: { addFunctionCallKey?: FunctionCallKeyRequest }) => Promise<unknown>;
  disconnect: () => Promise<void>;
  wallet: () => Promise<ActiveWallet | null>;
};

export type ActiveWallet = {
  signAndSendTransaction: (tx: {
    signerId: string;
    receiverId: string;
    actions: unknown[];
  }) => Promise<TxOutcome>;
};

export type ExecutionStatus = {
  SuccessValue?: string;
  Failure?: {
    ActionError?: { kind?: Record<string, unknown> };
  };
};

export type TxOutcome = {
  transaction: { hash: string; signer_id: string; receiver_id: string };
  status: ExecutionStatus & Record<string, unknown>;
  receipts_outcome?: Array<{ outcome: { logs: string[]; status?: ExecutionStatus } }>;
};

let connector: Connector | null = null;

async function getConnector(): Promise<Connector> {
  if (connector) return connector;

  const { NearConnector } = await import('@hot-labs/near-connect');
  const created = new NearConnector({ network: NETWORK }) as unknown as Connector;

  created.on('wallet:signIn', (payload) => {
    const signed = payload as { accounts?: Array<{ accountId: string }>; wallet?: { id?: string } };
    wallet.accountId = signed.accounts?.[0]?.accountId ?? null;
    wallet.walletId = signed.wallet?.id ?? null;
    wallet.connecting = false;
    wallet.error = null;
  });

  created.on('wallet:signOut', () => {
    wallet.accountId = null;
    wallet.walletId = null;
  });

  connector = created;
  return created;
}

/**
 * Restore a previous session. Safe to call on every mount.
 *
 * Deliberately does **not** call `connector.wallet()`. That method is
 * destructive on failure: when `getAccounts()` throws — which it does if the
 * wallet has not finished injecting itself into the page yet — near-connect
 * deletes the stored `selected-wallet` and gives up. Calling it on mount is
 * therefore a race against the wallet loading, and losing the race wipes the
 * session rather than reporting it missing.
 *
 * Creating the connector is enough: `autoConnect` reconnects on its own once
 * the wallet announces itself, and the `wallet:signIn` handler above fills in
 * the account. All this does is start that and wait a moment for it.
 */
export async function restoreWallet(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await getConnector();
    await waitForAccount();
  } finally {
    wallet.ready = true;
  }
}

/** Give a wallet that is still injecting itself a moment to arrive. */
async function waitForAccount(timeoutMs = 2_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (!wallet.accountId && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return wallet.accountId;
}

export async function connectWallet(): Promise<void> {
  wallet.connecting = true;
  wallet.error = null;
  try {
    await (await getConnector()).connect();
  } catch (error) {
    wallet.connecting = false;
    // A closed modal is a decision, not a failure.
    const message = error instanceof Error ? error.message : String(error);
    wallet.error = /reject|cancel|close/i.test(message) ? null : message;
  }
}

export async function disconnectWallet(): Promise<void> {
  try {
    await (await getConnector()).disconnect();
  } finally {
    wallet.accountId = null;
    wallet.walletId = null;
  }
}

export async function getActiveWallet(): Promise<ActiveWallet | null> {
  return (await getConnector()).wallet();
}

export type FunctionCallKeyRequest = {
  contractId: string;
  publicKey: string;
  allowMethods: { anyMethod: false; methodNames: string[] };
  gasAllowance?: { kind: 'limited'; amount: string } | { kind: 'unlimited' };
};

/**
 * Ask the player's wallet to add a function-call key.
 *
 * Reuses the connector the rest of the app already holds, and asks the wallet
 * that is *already* connected rather than opening the picker again — the
 * first version of this made its own connector and always called `connect()`,
 * so somebody who had just signed in on the gallery was asked to choose a
 * wallet a second time to grant a key to the one they had chosen.
 *
 * The picker still appears when nobody is connected, which is the only time
 * there is a choice to make.
 */
/**
 * The account this browser already has a session for, or null.
 *
 * Separate from `wallet.accountId` because that only fills in once
 * `restoreWallet` has run and the connector has replayed its sign-in event.
 * A page that needs to *say* whether it found a session has to ask directly.
 */
export async function connectedAccount(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  await getConnector();
  return waitForAccount();
}

export async function grantFunctionCallKey(
  request: FunctionCallKeyRequest
): Promise<string> {
  const connector = await getConnector();

  // Only ask for the wallet once something has actually signed in; asking
  // earlier can delete the stored session, as `restoreWallet` explains.
  await waitForAccount();
  const existing = wallet.accountId ? await connector.wallet().catch(() => null) : null;
  const active =
    existing ?? ((await connector.connect({ addFunctionCallKey: request })) as ActiveWallet | null);

  if (!active) throw new Error('No wallet connected');

  // An already-connected wallet still has to sign the AddKey; it just does
  // not have to be picked again.
  if (existing) {
    await (
      existing as unknown as {
        signIn: (params: { network: string; addFunctionCallKey: FunctionCallKeyRequest }) => Promise<unknown>;
      }
    ).signIn({ network: NETWORK, addFunctionCallKey: request });
  }

  const accounts = await (
    active as unknown as {
      getAccounts: (p: { network: string }) => Promise<Array<{ accountId: string }>>;
    }
  ).getAccounts({ network: NETWORK });

  const accountId = accounts[0]?.accountId ?? wallet.accountId;
  if (!accountId) throw new Error('The wallet connected but reported no account.');
  return accountId;
}
