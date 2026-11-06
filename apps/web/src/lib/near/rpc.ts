import { RPC_URL } from '#lib/config';

type RpcError = { message?: string; data?: unknown; cause?: { info?: unknown } };

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'joygotchi', method, params })
  });

  if (!response.ok) throw new Error(`NEAR RPC ${method} failed: HTTP ${response.status}`);

  const body = (await response.json()) as { result?: T; error?: RpcError };
  if (body.error) {
    throw new Error(`NEAR RPC ${method} failed: ${body.error.message ?? 'unknown error'}`);
  }
  if (body.result === undefined) throw new Error(`NEAR RPC ${method} returned nothing`);
  return body.result;
}

type CallResult = { result: number[]; error?: string };

/** Read-only contract call. Works in the browser and on the server. */
export async function viewFunction<T>(
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const outcome = await rpc<CallResult>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: methodName,
    args_base64: btoa(JSON.stringify(args))
  });

  if (outcome.error) throw new Error(`${contractId}.${methodName}: ${outcome.error}`);

  const text = new TextDecoder().decode(new Uint8Array(outcome.result));
  return (text === '' ? null : JSON.parse(text)) as T;
}

/** Yocto balance of an account, or "0" if it does not exist. */
export async function accountBalance(accountId: string): Promise<string> {
  try {
    const account = await rpc<{ amount: string }>('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId
    });
    return account.amount;
  } catch {
    return '0';
  }
}
