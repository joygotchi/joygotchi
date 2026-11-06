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

/** Restore a previous session. Safe to call on every mount. */
export async function restoreWallet(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const active = await (await getConnector()).wallet();
    if (active && !wallet.accountId) {
      // near-connect replays `wallet:signIn` for a restored session, so the
      // handler above usually fills this in; this is the fallback for when it
      // resolves the wallet without re-emitting.
      const accounts = await (
        active as unknown as { getAccounts?: () => Promise<Array<{ accountId: string }>> }
      ).getAccounts?.();
      wallet.accountId = accounts?.[0]?.accountId ?? wallet.accountId;
    }
  } catch {
    // No stored session. Not an error worth showing anybody.
  } finally {
    wallet.ready = true;
  }
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
export async function grantFunctionCallKey(
  request: FunctionCallKeyRequest
): Promise<string> {
  const connector = await getConnector();

  const existing = await connector.wallet().catch(() => null);
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
