<script lang="ts">
  import { page } from '$app/state';
  import { formatNear } from '#lib/near/amount';
  import { getActiveWallet, connectedAccount, wallet } from '#lib/near/wallet.svelte';
  import { GAS } from '#lib/config';

  /**
   * Sign one transaction for the desktop app.
   *
   * Some things a session key cannot do. `stake_pet` and `unstake_pet` require
   * one yoctoNEAR, and a function-call key may never attach a deposit — that
   * requirement *is* the check, and it means a real wallet signature. So the
   * app sends the player here for those, the same way it sends them here to
   * connect, and the result comes home over loopback.
   *
   * Nothing here is generic on purpose. A page that signs whatever a link asks
   * for is a page that signs whatever a link asks for, so the whitelist below
   * is the whole security model and the screen shows what it is about to do.
   */
  const ALLOWED = {
    stake_pet: {
      label: 'Put this pet to work',
      blurb: 'It starts earning AI credits, and cannot battle or be sold until you take it back.'
    },
    unstake_pet: {
      label: 'Bring this pet home',
      blurb: 'It stops earning. Credits it has already earned stay yours.'
    }
  } as const;

  type Method = keyof typeof ALLOWED;

  let phase = $state<'review' | 'signing' | 'done' | 'error'>('review');
  let message = $state<string | null>(null);
  let returnUrl = $state<string | null>(null);
  let signedInAs = $state<string | null>(null);
  let checked = $state(false);

  const params = $derived(page.url.searchParams);
  const method = $derived(params.get('method') ?? '');
  const contractId = $derived(params.get('contract') ?? '');
  const petId = $derived(Number(params.get('pet_id') ?? '0'));
  const callback = $derived(params.get('callback') ?? '');

  /** Only loopback, for the same reason as `/connect`. */
  function loopbackOnly(raw: string): URL | null {
    try {
      const url = new URL(raw);
      const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
      return url.protocol === 'http:' && local ? url : null;
    } catch {
      return null;
    }
  }

  const target = $derived(loopbackOnly(callback));
  const known = $derived(method in ALLOWED ? ALLOWED[method as Method] : null);
  /** The staking contract and nothing else: these two methods live there. */
  const contractOk = $derived(/^jg-stake-[a-z0-9-]+\.(testnet|near)$/.test(contractId));
  const valid = $derived(known !== null && contractOk && petId > 0 && target !== null);

  $effect(() => {
    void connectedAccount().then((account) => {
      signedInAs = account;
      checked = true;
    });
  });

  async function report(extra: Record<string, string>) {
    if (!target) return;
    target.searchParams.set('method', method);
    for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, value);

    const url = target.toString();
    returnUrl = url;
    // Reaches the app without a navigation, which https → http can block.
    await fetch(url, { mode: 'no-cors' }).catch(() => {});
    window.location.href = url;
  }

  async function sign() {
    if (!valid) return;
    phase = 'signing';
    message = null;

    try {
      const active = await getActiveWallet();
      if (!active || !wallet.accountId) throw new Error('Connect a wallet first.');

      const outcome = await active.signAndSendTransaction({
        signerId: wallet.accountId,
        receiverId: contractId,
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: method,
              args: { pet_id: petId },
              gas: GAS.heavy,
              // The yoctoNEAR the contract asks for, and the reason this page
              // exists rather than the app signing it.
              deposit: '1'
            }
          }
        ]
      });

      phase = 'done';
      await report({ tx_hash: outcome.transaction?.hash ?? 'unknown' });
    } catch (cause) {
      phase = 'error';
      message = cause instanceof Error ? cause.message : String(cause);
      await report({ error: message.slice(0, 120) });
    }
  }
</script>

<svelte:head><title>{known?.label ?? 'Action'} · JOYGOTCHI</title></svelte:head>

<div class="mx-auto max-w-lg">
  <h1 class="text-sm tracking-widest text-muted uppercase">One transaction</h1>

  {#if !valid}
    <div class="mt-4 border border-bad/40 bg-panel p-4 text-xs">
      <p class="text-bad">This link is not one the desktop app made.</p>
      <ul class="mt-2 space-y-1 text-muted">
        {#if !known}<li>· "{method || 'nothing'}" is not something this page will sign</li>{/if}
        {#if !contractOk}<li>· it names a contract this page does not act on</li>{/if}
        {#if petId <= 0}<li>· no pet named</li>{/if}
        {#if target === null}<li>· it would report somewhere other than this machine</li>{/if}
      </ul>
    </div>
  {:else if phase === 'done'}
    <div class="mt-4 border border-line bg-panel p-4 text-xs">
      <p class="text-accent">Signed. Back to the app…</p>
      {#if returnUrl}
        <p class="mt-2 text-muted">
          Still here? <a class="text-accent hover:underline" href={returnUrl}>Tell the app</a>.
        </p>
      {/if}
    </div>
  {:else}
    <div class="mt-4 border border-line bg-panel">
      <div class="border-b border-line px-4 py-3">
        <p class="text-sm">{known?.label}</p>
        <p class="mt-1 text-xs text-muted">{known?.blurb}</p>

        {#if checked && !signedInAs}
          <p class="mt-2 text-warn">
            No wallet is connected in this browser. Connect one first — the button below needs a
            real signature, which is the whole reason this is not happening in the app.
          </p>
        {/if}
      </div>

      <dl class="divide-y divide-line text-xs">
        <div class="flex justify-between gap-3 px-4 py-2">
          <dt class="text-muted">Contract</dt>
          <dd>{contractId}</dd>
        </div>
        <div class="flex justify-between gap-3 px-4 py-2">
          <dt class="text-muted">Method</dt>
          <dd>{method}</dd>
        </div>
        <div class="flex justify-between gap-3 px-4 py-2">
          <dt class="text-muted">Pet</dt>
          <dd>#{petId}</dd>
        </div>
        <div class="flex justify-between gap-3 px-4 py-2">
          <dt class="text-muted">It costs</dt>
          <dd class="text-accent">{formatNear('1', 24)} NEAR — one yoctoNEAR, plus gas</dd>
        </div>
      </dl>

      <div class="flex gap-2 border-t border-line p-4 text-xs">
        <button
          class="flex-1 border border-accent bg-accent px-3 py-2 font-bold text-ink disabled:opacity-40"
          disabled={phase === 'signing'}
          onclick={sign}
        >
          {phase === 'signing' ? 'Waiting for your wallet…' : 'Sign it'}
        </button>
        <button
          class="border border-line px-3 py-2 hover:border-line-bright"
          onclick={() => report({ error: 'cancelled' })}
        >
          Cancel
        </button>
      </div>

      {#if message}
        <p class="border-t border-bad/30 px-4 py-2 text-xs text-bad">{message}</p>
      {/if}
    </div>
  {/if}
</div>
