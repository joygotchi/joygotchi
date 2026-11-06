import { GAS } from '#lib/config';
import {
  getActiveWallet,
  wallet,
  type ExecutionStatus,
  type TxOutcome
} from './wallet.svelte';

export class WalletNotConnectedError extends Error {
  constructor() {
    super('Connect a wallet first');
    this.name = 'WalletNotConnectedError';
  }
}

/** A transaction the chain accepted, whose work failed further down. */
export class ReceiptFailedError extends Error {
  constructor(
    message: string,
    readonly txHash: string
  ) {
    super(message);
    this.name = 'ReceiptFailedError';
  }
}

function panicMessage(status: ExecutionStatus | undefined): string | null {
  const kind = status?.Failure?.ActionError?.kind;
  if (!kind) return null;

  const execution = (kind as { FunctionCallError?: { ExecutionError?: string } }).FunctionCallError
    ?.ExecutionError;
  if (typeof execution === 'string') {
    return execution.replace(/^Smart contract panicked:\s*/, '');
  }
  return Object.keys(kind)[0] ?? 'the call failed';
}

/**
 * Throw if any receipt failed, not just the first one.
 *
 * A NEAR transaction reports success as soon as its first receipt is accepted,
 * so anything a contract does in a cross-contract callback fails silently from
 * here. Staking a pet owned by somebody else used to come back as a clean
 * success in this project's previous app, because the ownership check lives in
 * the callback. Checked in one place rather than at call sites, since the calls
 * that cross contracts are not the ones that look like they do.
 */
export function assertReceiptsSucceeded(outcome: TxOutcome): TxOutcome {
  const statuses = [
    outcome.status,
    ...(outcome.receipts_outcome ?? []).map((receipt) => receipt.outcome.status)
  ];

  for (const status of statuses) {
    const message = panicMessage(status);
    if (message) throw new ReceiptFailedError(message, outcome.transaction?.hash ?? '');
  }
  return outcome;
}

/** Every log line the transaction produced, across all receipts. */
export function txLogs(outcome: TxOutcome): string[] {
  return (outcome.receipts_outcome ?? []).flatMap((receipt) => receipt.outcome.logs);
}

/** Parse the NEP-297 events a transaction emitted. */
export function txEvents(outcome: TxOutcome): Array<{ event: string; data: unknown[] }> {
  const events: Array<{ event: string; data: unknown[] }> = [];
  for (const line of txLogs(outcome)) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      const parsed = JSON.parse(line.slice('EVENT_JSON:'.length)) as {
        event?: string;
        data?: unknown[];
      };
      if (parsed.event) events.push({ event: parsed.event, data: parsed.data ?? [] });
    } catch {
      // A malformed event line is the contract's problem, not the page's.
    }
  }
  return events;
}

/** Sign and send one function call, then check that all of it worked. */
export async function callFunction(
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
  options: { gas?: string; deposit?: string } = {}
): Promise<TxOutcome> {
  const active = await getActiveWallet();
  if (!active || !wallet.accountId) throw new WalletNotConnectedError();

  const outcome = await active.signAndSendTransaction({
    signerId: wallet.accountId,
    receiverId: contractId,
    actions: [
      {
        type: 'FunctionCall',
        params: {
          methodName,
          args,
          gas: options.gas ?? GAS.call,
          deposit: options.deposit ?? '0'
        }
      }
    ]
  });

  return assertReceiptsSucceeded(outcome);
}
