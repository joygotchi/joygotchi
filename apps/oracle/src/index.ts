/**
 * The feed oracle.
 *
 * `auto_feed` and `award_feed_xp` are gated to one account on the staking
 * contract, and nothing has ever called them — so the auto-feed switch in
 * the app has been permission granted to nobody, and a fed pet has earned no
 * XP. This is the process that makes both real.
 *
 * It holds one key, and that key is deliberately weak: a function-call key
 * for `auto_feed` on the staking contract and nothing else. It cannot move
 * NEAR, cannot touch a pet, and cannot spend a player's credits beyond the
 * daily budget that player set on chain. If this machine is taken, what is
 * taken with it is the ability to feed people's pets on schedule.
 *
 * It never decides who may be fed — the contract does. It decides only which
 * of the already-permitted meals are worth buying now, and `decide.ts` holds
 * that reasoning away from the network.
 *
 * It does two jobs, because they need the same key. On a timer it buys meals
 * for pets about to starve. On a loopback port it grades meals the app just
 * bought and pays their XP: the web service has the model and returns a
 * number, and the signing happens here, so no key that writes to the
 * contract has to live on a host we rent.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from 'near-api-js';
import { ACTION_PRICE } from '@joygotchi/pet';
import { DEFAULT_RULES, decideMeals, type AutoFeedAccount, type OwnedPet } from './decide.ts';

import { serve } from './serve.ts';
import type { TxStatus } from '@joygotchi/pet';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. See apps/oracle/README.md.`);
    process.exit(1);
  }
  return value;
};

const NETWORK = process.env.NETWORK ?? 'testnet';
const STAKE = process.env.STAKE_CONTRACT ?? 'jg-stake-5656.testnet';
const GAME = process.env.GAME_CONTRACT ?? 'jg-game-5656.testnet';
const EVERY_MS = Number(process.env.POLL_SECONDS ?? 300) * 1000;
const DRY_RUN = process.env.DRY_RUN === '1';
const PORT = Number(process.env.ORACLE_PORT ?? 8787);
const SITE = (process.env.SITE ?? 'https://joygotchi.vercel.app').replace(/\/$/, '');

/*
 * Two nodes. A single public endpoint is a single point of failure for a
 * process whose whole job is to be running when nobody is watching.
 */
const RPC_URLS =
  NETWORK === 'mainnet'
    ? ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org']
    : ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];

/**
 * The secret, from the place it already lives.
 *
 * `ORACLE_KEY` works, but a key pasted into an environment variable has been
 * through a shell, which means it is in a history file. `near-cli` already
 * stores keys under `~/.near-credentials`, so the default is to read the one
 * it wrote: the secret never appears in a command, a log or a transcript,
 * and granting it is one `near account add-key` with no printing.
 */
function secretKey(accountId: string): KeyPairString {
  const fromEnv = process.env.ORACLE_KEY;
  if (fromEnv) return fromEnv as KeyPairString;

  const path =
    process.env.ORACLE_KEY_FILE ??
    join(homedir(), '.near-credentials', NETWORK, `${accountId}.json`);

  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      private_key?: string;
      secret_key?: string;
    };
    const key = stored.private_key ?? stored.secret_key;
    if (key) return key as KeyPairString;
    throw new Error('no private_key in that file');
  } catch (error) {
    console.error(
      `No key for ${accountId}. Set ORACLE_KEY, or grant one with ` +
        `\`near account add-key\` and \`save-to-legacy-keychain\` so it lands at ${path}. ` +
        `(${error instanceof Error ? error.message : String(error)})`
    );
    process.exit(1);
  }
}

const log = (message: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...extra }));

async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < RPC_URLS.length * 2; attempt++) {
    const url = RPC_URLS[attempt % RPC_URLS.length]!;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'oracle',
          method: 'query',
          params: {
            request_type: 'call_function',
            finality: 'final',
            account_id: contractId,
            method_name: method,
            args_base64: Buffer.from(JSON.stringify(args)).toString('base64')
          }
        })
      });
      const body = (await response.json()) as {
        result?: { result: number[] };
        error?: { message?: string };
      };
      if (!body.result) throw new Error(body.error?.message ?? `${method} returned nothing`);
      const text = Buffer.from(body.result.result).toString();
      return (text === '' ? null : JSON.parse(text)) as T;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** A transaction with all its receipts, which `mealFrom` reads. */
async function txStatus(txHash: string, accountId: string): Promise<TxStatus> {
  let lastError: unknown;
  for (const url of RPC_URLS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'oracle',
          method: 'tx',
          params: { tx_hash: txHash, sender_account_id: accountId, wait_until: 'EXECUTED' }
        })
      });
      const body = (await response.json()) as { result?: TxStatus };
      if (!body.result) throw new Error('no such transaction');
      return body.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Something for the pet to say about its meal.
 *
 * The web service holds the NEAR AI key, which is why it is asked rather
 * than called from here. It used to decide the XP as well; `feedXp` does
 * that now, from the chain, so this is flavour and nothing depends on it.
 */
async function line(petId: number): Promise<string | null> {
  const response = await fetch(`${SITE}/api/ai/grade`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ petId })
  });
  const body = (await response.json()) as { line?: unknown };
  return typeof body.line === 'string' && body.line.trim() ? body.line.trim() : null;
}

async function round(account: Account | null) {
  const accounts =
    (await view<AutoFeedAccount[]>(STAKE, 'get_auto_feed_accounts', {
      from_index: 0,
      limit: 100
    })) ?? [];

  if (accounts.length === 0) {
    log('nobody has auto-feed on');
    return;
  }

  // Fetched once per account and handed to the decision, which stays pure.
  const pets = new Map<string, OwnedPet[]>();
  for (const entry of accounts) {
    pets.set(
      entry.account_id,
      (await view<OwnedPet[]>(GAME, 'get_pets_for_owner', {
        account_id: entry.account_id
      })) ?? []
    );
  }

  const meals = decideMeals(accounts, (id) => pets.get(id) ?? [], {
    ...DEFAULT_RULES,
    price: Math.round(ACTION_PRICE.auto_feed * 1e6)
  });

  log('round', { accounts: accounts.length, meals: meals.length });

  for (const meal of meals) {
    if (!account) {
      log('would feed', meal);
      continue;
    }
    try {
      const outcome = await account.callFunctionRaw({
        contractId: STAKE,
        methodName: 'auto_feed',
        args: { account_id: meal.accountId, pet_id: meal.petId },
        gas: 100_000_000_000_000n,
        deposit: 0n
      });
      /*
       * `auto_feed` refunds and returns false rather than panicking when the
       * game refuses — a pet that starved, or one that is not theirs. The
       * transaction succeeds either way, so the logs are the only place the
       * difference shows.
       */
      const logs = outcome.receipts_outcome?.flatMap((r) => r.outcome.logs) ?? [];
      const refunded = logs.some((line) => line.includes('auto_feed_refunded'));
      log(refunded ? 'refused' : 'fed', { ...meal, tx: outcome.transaction?.hash });
    } catch (error) {
      log('failed', { ...meal, why: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function main() {
  /*
   * A dry run needs no key, deliberately. Seeing what this would spend on
   * other people's pets should not require holding the key that could, and
   * asking someone to invent one to read a plan is how placeholder secrets
   * end up in shell history.
   */
  const accountId = DRY_RUN ? (process.env.ORACLE_ACCOUNT ?? 'dry-run') : required('ORACLE_ACCOUNT');
  const provider = new JsonRpcProvider({ url: RPC_URLS[0]! });
  const account = DRY_RUN
    ? null
    : new Account(
        accountId,
        provider,
        KeyPairSigner.fromSecretKey(secretKey(accountId))
      );

  log('started', { accountId, stake: STAKE, game: GAME, everySeconds: EVERY_MS / 1000, DRY_RUN });

  serve(
    PORT,
    {
      stake: STAKE,
      game: GAME,
      view,
      txStatus,
      line,
      award: account
        ? async (petId, xp, meal) => {
            const outcome = await account.callFunctionRaw({
              contractId: STAKE,
              methodName: 'award_feed_xp',
              args: { pet_id: petId, xp, meal },
              gas: 100_000_000_000_000n,
              deposit: 0n
            });
            return outcome.transaction?.hash;
          }
        : null
    },
    log
  );

  // Sequential, not an interval: a slow round must not overlap the next one
  // and feed the same pet twice.
  for (;;) {
    try {
      await round(account);
    } catch (error) {
      log('round failed', { why: error instanceof Error ? error.message : String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, EVERY_MS));
  }
}

void main();
