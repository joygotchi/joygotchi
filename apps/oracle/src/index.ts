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
 */
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from 'near-api-js';
import { ACTION_PRICE } from '@joygotchi/pet';
import { DEFAULT_RULES, decideMeals, type AutoFeedAccount, type OwnedPet } from './decide.ts';

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

/*
 * Two nodes. A single public endpoint is a single point of failure for a
 * process whose whole job is to be running when nobody is watching.
 */
const RPC_URLS =
  NETWORK === 'mainnet'
    ? ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org']
    : ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];

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
        // `ed25519:…`, as the wallet writes it.
        KeyPairSigner.fromSecretKey(required('ORACLE_KEY') as KeyPairString)
      );

  log('started', { accountId, stake: STAKE, game: GAME, everySeconds: EVERY_MS / 1000, DRY_RUN });

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
