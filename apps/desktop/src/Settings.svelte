<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import {
    SESSION_DAYS,
    SESSION_METHODS,
    beginConnect,
    clearSession,
    completeConnect,
    getSession,
    sessionExpired,
    type Session
  } from './wallet';
  import type { InstalledPet } from './types';

  type Props = {
    pets: InstalledPet[];
    active: string | null;
    onclose: () => void;
    onpick: (slug: string) => void;
    onrefresh: () => void;
  };
  let { pets, active, onclose, onpick, onrefresh }: Props = $props();

  let port = $state<number | null>(null);
  let root = $state('');
  let clickThrough = $state(false);

  /**
   * Let clicks fall through to whatever is behind the pet.
   *
   * It has to be switched from here rather than by hovering the pet: a window
   * that ignores cursor events cannot notice a cursor. Turning it on means the
   * pet stops being draggable until it is turned off again, so the label says
   * so.
   */
  async function toggleClickThrough(next: boolean) {
    clickThrough = next;
    await invoke('set_click_through', { ignore: next }).catch(() => {});
  }

  let session = $state<Session | null>(null);
  let connecting = $state(false);
  let walletError = $state<string | null>(null);

  const network = $derived(pets[0]?.chain.network ?? 'testnet');
  const gameContract = $derived(pets[0]?.chain.contract ?? '');
  const expired = $derived(session ? sessionExpired(session) : false);

  /**
   * The keypair exists only between opening the wallet and hearing back. If
   * the player closes the tab it is dropped, and nothing was ever written —
   * an abandoned sign-in should not leave a key on disk.
   */
  let pending: Awaited<ReturnType<typeof beginConnect>> | null = null;

  async function connect() {
    if (!gameContract) {
      walletError = 'Install a pet first — the contract comes from its pet.json.';
      return;
    }
    connecting = true;
    walletError = null;
    try {
      pending = await beginConnect(gameContract, network);
    } catch (cause) {
      connecting = false;
      walletError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  $effect(() => {
    void getSession().then((found) => (session = found));

    const connected = listen<{ accountId: string }>('wallet-connected', async (event) => {
      if (!pending) return;
      try {
        session = await completeConnect(pending, event.payload.accountId);
      } catch (cause) {
        walletError = cause instanceof Error ? cause.message : String(cause);
      } finally {
        pending = null;
        connecting = false;
      }
    });

    const cancelled = listen('wallet-cancelled', () => {
      pending = null;
      connecting = false;
      walletError = 'The wallet did not grant anything.';
    });

    return () => {
      void connected.then((off) => off());
      void cancelled.then((off) => off());
    };
  });

  $effect(() => {
    void invoke<number>('hook_port').then((value) => (port = value));
    void invoke<string>('pets_directory').then((value) => (root = value));
  });
</script>

<div class="panel">
  <header>
    <span>Pets</span>
    <button onclick={onclose} title="Close">✕</button>
  </header>

  {#if pets.length === 0}
    <p class="empty">
      Nothing in <code>{root}</code> yet. Copy a pet's install code from the gallery and run
      <code>npx joygotchi install &lt;code&gt;</code>.
    </p>
  {:else}
    <ul>
      {#each pets as pet (pet.slug)}
        <li>
          <button class:active={pet.slug === active} onclick={() => onpick(pet.slug)}>
            <span class="name">{pet.displayName}</span>
            <span class="meta">{pet.rarity} · lv {pet.level}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <section class="wallet">
    <label class="row toggle">
      <span class="muted">Click through the pet</span>
      <input
        checked={clickThrough}
        onchange={(event) => toggleClickThrough(event.currentTarget.checked)}
        type="checkbox"
      />
    </label>
    <p class="fine">
      Lets clicks reach the window underneath. The pet stops being draggable while this is on.
    </p>
  </section>

  <section class="wallet">
    {#if session && !expired}
      <div class="row">
        <span class="muted">Signing as</span>
        <span class="accent">{session.accountId}</span>
      </div>
      <p class="fine">
        A key limited to {session.methodNames.length} methods on {session.contractId}. It cannot
        move NEAR or your pets. Remove it in your wallet to revoke it.
      </p>
      <button onclick={async () => { await clearSession(); session = null; }}>Forget this key</button>
    {:else}
      <div class="row">
        <span class="muted">Wallet</span>
        <span>{expired ? 'session expired' : 'not connected'}</span>
      </div>
      <p class="fine">
        Opens your browser once. Your wallet grants a key for
        {SESSION_METHODS.length} methods, good for {SESSION_DAYS} days — feeding, items and
        claiming sign here with no popups. Staking still asks your wallet, by design.
      </p>
      <button disabled={connecting} onclick={connect}>
        {connecting ? 'Waiting for the wallet…' : 'Connect wallet'}
      </button>
    {/if}

    {#if walletError}<p class="bad">{walletError}</p>{/if}
  </section>

  <footer>
    <button onclick={onrefresh}>Rescan</button>
    {#if port}<span>hooks on 127.0.0.1:{port}</span>{/if}
    <button class="quit" onclick={() => invoke('quit')}>Quit</button>
  </footer>
</div>

<style>
  .panel {
    position: absolute;
    inset: 4px;
    display: flex;
    flex-direction: column;
    background: #0b0d10f2;
    border: 1px solid #39414d;
    font-size: 11px;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    border-bottom: 1px solid #242a33;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #8b95a3;
  }

  header button,
  .wallet {
    border-top: 1px solid #242a33;
    padding: 6px 8px;
  }

  .toggle {
    cursor: pointer;
    align-items: center;
  }

  .wallet .row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  .wallet button {
    margin-top: 4px;
    width: 100%;
    background: none;
    border: 1px solid #242a33;
    color: inherit;
    font: inherit;
    padding: 3px 8px;
    cursor: pointer;
  }

  .wallet button:disabled {
    opacity: 0.5;
  }

  .fine {
    margin: 4px 0 0;
    color: #8b95a3;
    font-size: 10px;
    line-height: 1.5;
  }

  .accent {
    color: #b6f36b;
  }

  .muted {
    color: #8b95a3;
  }

  .bad {
    margin: 4px 0 0;
    color: #f36b7b;
    font-size: 10px;
  }

  footer button.quit {
    border-color: #4a2a30;
    color: #f36b7b;
  }

  footer button {
    background: none;
    border: 1px solid #242a33;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 1px 6px;
  }

  ul {
    flex: 1;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
  }

  li button {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    background: none;
    border: 0;
    border-bottom: 1px solid #171b22;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  li button.active {
    color: #b6f36b;
  }

  .meta {
    color: #8b95a3;
  }

  .empty {
    flex: 1;
    margin: 0;
    padding: 10px 8px;
    color: #8b95a3;
    line-height: 1.5;
  }

  .empty code {
    color: #b6f36b;
  }

  footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 8px;
    border-top: 1px solid #242a33;
    color: #8b95a3;
    font-size: 10px;
  }
</style>
