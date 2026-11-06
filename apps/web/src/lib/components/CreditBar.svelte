<script lang="ts">
  import {
    claimCredits,
    claimFaucet,
    claimMining,
    formatCredits,
    getStakeAccount,
    miningAvailableAt,
    type StakeAccount
  } from '#lib/economy';
  import { wallet } from '#lib/near/wallet.svelte';

  /**
   * AI credits: what is spendable, what is still accruing, and the two taps
   * that top them up.
   *
   * `pending` and `balance` are deliberately shown apart. The contract only
   * ever spends `balance`, and `claim_credits` is what moves one into the
   * other — adding them into a single number is how you get a player told
   * "not enough credits" while the page shows plenty.
   */
  let account = $state<StakeAccount | null>(null);
  let miningAt = $state<number>(0);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let now = $state(Date.now());

  const balance = $derived(account ? Number(formatCredits(account.credit_balance, 6)) : 0);
  const pending = $derived(account ? Number(formatCredits(account.pending_credits, 6)) : 0);
  const miningIn = $derived(Math.max(0, Math.round((miningAt - now) / 1000)));

  async function load() {
    if (!wallet.accountId) {
      account = null;
      return;
    }
    const [acc, mining] = await Promise.all([
      getStakeAccount(wallet.accountId).catch(() => null),
      miningAvailableAt(wallet.accountId).catch(() => '0')
    ]);
    account = acc;
    miningAt = Number(mining) / 1e6;
  }

  async function run(label: string, action: () => Promise<unknown>) {
    busy = label;
    error = null;
    try {
      await action();
      await load();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = null;
    }
  }

  $effect(() => {
    void wallet.accountId;
    void load();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
</script>

{#if wallet.accountId}
  <div class="border border-line bg-panel">
    <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
      <h2 class="text-sm tracking-widest text-muted uppercase">AI credits</h2>
      <div class="flex items-baseline gap-4 text-xs">
        <span><span class="text-accent">{balance.toFixed(3)}</span> <span class="text-muted">spendable</span></span>
        <span><span class="text-text">{pending.toFixed(3)}</span> <span class="text-muted">earned, unclaimed</span></span>
      </div>
    </div>

    <div class="flex flex-wrap gap-2 p-4 text-xs">
      <button
        class="border border-accent bg-accent px-3 py-2 font-bold text-ink disabled:opacity-40"
        disabled={busy !== null || pending <= 0}
        onclick={() => run('claim', claimCredits)}
      >
        {busy === 'claim' ? 'Claiming…' : 'Claim'}
      </button>

      <button
        class="border border-line px-3 py-2 hover:border-line-bright disabled:opacity-40"
        disabled={busy !== null}
        onclick={() => run('faucet', claimFaucet)}
        title="Ten credits, once per account"
      >
        {busy === 'faucet' ? 'Claiming…' : 'Faucet'}
      </button>

      <button
        class="border border-line px-3 py-2 hover:border-line-bright disabled:opacity-40"
        disabled={busy !== null || miningIn > 0}
        onclick={() => run('mining', claimMining)}
        title="A small top-up every six hours"
      >
        {#if miningIn > 0}
          Mine in {Math.floor(miningIn / 3600)}h {Math.floor((miningIn % 3600) / 60)}m
        {:else}
          {busy === 'mining' ? 'Mining…' : 'Mine'}
        {/if}
      </button>

      {#if account}
        <span class="ml-auto self-center text-[0.65rem] text-muted">
          {account.staked_pets.length} staked · weight {account.weight}
        </span>
      {/if}
    </div>

    {#if error}
      <p class="border-t border-bad/30 px-4 py-2 text-xs text-bad">{error}</p>
    {/if}
  </div>
{/if}
