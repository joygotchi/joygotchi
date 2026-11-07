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
  /**
   * The stored session — the same lookup `wallet()` does, without the side
   * effect. `wallet()` ends in `storage.remove('selected-wallet')` whenever
   * the lookup fails, and it fails on a freshly loaded page simply because
   * the wallet has not dispatched `near-wallet-injected` yet. This one just
   * throws. That difference is the entire fix.
   */
  getConnectedWallet: () => Promise<{
    wallet: ActiveWallet & { manifest?: { id?: string } };
    accounts: Array<{ accountId: string }>;
  }>;
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
 * Two things about near-connect 0.12 make this less obvious than it looks,
 * and both were read out of its source rather than guessed:
 *
 * `autoConnect` is on by default but only ever fires on the postMessage path
 * — an app running *inside* a wallet's iframe. For an ordinary browser with
 * an injected or web wallet, the injection handler only registers the wallet
 * and emits `selector:walletsChanged`; it never reconnects. So waiting for a
 * `wallet:signIn` event to replay on page load waits for something that is
 * never coming.
 *
 * And `connector.wallet()` deletes the stored session when its lookup fails.
 * On a page that has just loaded it fails for a reason that has nothing to do
 * with the session being invalid: the wallet is in storage but not yet in the
 * connector's wallet list, because it has not announced itself. Calling it on
 * mount is a race, and losing the race logs the player out for good.
 *
 * `getConnectedWallet()` is the same lookup without the delete, so this polls
 * that until the wallet turns up or the deadline passes. A session survives
 * the refresh; a genuinely absent one costs a few hundred milliseconds.
 */
export async function restoreWallet(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const connector = await getConnector();
    const deadline = Date.now() + 4_000;

    while (Date.now() < deadline) {
      const found = await connector.getConnectedWallet().catch(() => null);
      const accountId = found?.accounts?.[0]?.accountId;
      if (accountId) {
        wallet.accountId = accountId;
        wallet.walletId = found?.wallet.manifest?.id ?? wallet.walletId;
        return;
      }
      // A real sign-in happening in another tab, or `connect()` racing us.
      if (wallet.accountId) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
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
  const connector = await getConnector();
  // Not `wallet()`: see the note on `getConnectedWallet` above. Signing is
  // not worth risking the stored session over.
  const found = await connector.getConnectedWallet().catch(() => null);
  return found?.wallet ?? null;
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
  await restoreWallet();
  return wallet.accountId;
}

/**
 * Add the same key to a second contract.
 *
 * A function-call key is bound to one contract, so playing from the desktop
 * takes two — the lab and the game. The wallet signs the first during sign-in
 * and this one as an ordinary `AddKey`, which keeps both grants inside one
 * visit rather than sending somebody round twice.
 */
export async function addKeyForContract(request: FunctionCallKeyRequest): Promise<void> {
  const active = await getActiveWallet();
  if (!active || !wallet.accountId) throw new Error('No wallet connected');

  await (
    active as unknown as {
      signAndSendTransaction: (tx: {
        signerId: string;
        receiverId: string;
        actions: unknown[];
      }) => Promise<unknown>;
    }
  ).signAndSendTransaction({
    signerId: wallet.accountId,
    // An AddKey acts on your own account, not on the contract it permits.
    receiverId: wallet.accountId,
    actions: [
      {
        type: 'AddKey',
        params: {
          publicKey: request.publicKey,
          accessKey: {
            permission: {
              receiverId: request.contractId,
              methodNames: request.allowMethods.methodNames,
              allowance:
                request.gasAllowance?.kind === 'limited' ? request.gasAllowance.amount : undefined
            }
          }
        }
      }
    ]
  });
}

/**
 * Sign in, and grant the key as an explicit `AddKey`.
 *
 * Not through sign-in's own `addFunctionCallKey`. That path produced a key
 * with **no method restriction at all** — on chain the lab key came back with
 * `method_names: []`, which NEAR reads as "any method on this contract", so it
 * could call `list_item` and `buy_listing`, the two the app goes out of its
 * way to exclude. The wallet simply did not carry the list through.
 *
 * `AddKey` does carry it: the game key granted the same way came back
 * restricted to `attack, evolve` exactly. So both keys go through `AddKey`,
 * and sign-in is only used to establish which wallet is signing.
 */
export async function grantFunctionCallKey(
  request: FunctionCallKeyRequest
): Promise<string> {
  const connector = await getConnector();

  // Only ask for the wallet once something has actually signed in; asking
  // earlier can delete the stored session, as `restoreWallet` explains.
  await restoreWallet();
  const existing = (await connector.getConnectedWallet().catch(() => null))?.wallet ?? null;
  const active = existing ?? ((await connector.connect()) as ActiveWallet | null);

  if (!active) throw new Error('No wallet connected');

  const accounts = await (
    active as unknown as {
      getAccounts: (p: { network: string }) => Promise<Array<{ accountId: string }>>;
    }
  ).getAccounts({ network: NETWORK });

  const accountId = accounts[0]?.accountId ?? wallet.accountId;
  if (!accountId) throw new Error('The wallet connected but reported no account.');

  await addKeyForContract(request);
  return accountId;
}
