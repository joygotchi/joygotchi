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
  connect: () => Promise<unknown>;
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
