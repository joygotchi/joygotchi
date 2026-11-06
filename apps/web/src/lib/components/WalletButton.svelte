<script lang="ts">
  import { truncateAccount } from '#lib/near/amount';
  import {
    connectWallet,
    disconnectWallet,
    restoreWallet,
    wallet
  } from '#lib/near/wallet.svelte';

  let open = $state(false);

  $effect(() => {
    void restoreWallet();
  });
</script>

{#if wallet.accountId}
  <div class="relative">
    <button
      class="border border-line bg-panel px-3 py-2 text-xs hover:border-line-bright"
      onclick={() => (open = !open)}
    >
      <span class="text-accent">◆</span>
      {truncateAccount(wallet.accountId)}
    </button>

    {#if open}
      <div class="absolute right-0 z-20 mt-1 w-48 border border-line bg-panel-2 text-xs">
        <a class="block px-3 py-2 hover:bg-panel" href="/me" onclick={() => (open = false)}>
          My pets
        </a>
        <button
          class="block w-full px-3 py-2 text-left text-bad hover:bg-panel"
          onclick={async () => {
            open = false;
            await disconnectWallet();
          }}
        >
          Disconnect
        </button>
      </div>
    {/if}
  </div>
{:else}
  <button
    class="border border-accent bg-accent px-3 py-2 text-xs font-bold text-ink hover:bg-accent-dim disabled:opacity-50"
    disabled={wallet.connecting}
    onclick={connectWallet}
  >
    {wallet.connecting ? 'Connecting…' : 'Connect wallet'}
  </button>
{/if}

{#if wallet.error}
  <span class="text-xs text-bad">{wallet.error}</span>
{/if}
