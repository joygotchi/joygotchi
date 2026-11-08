<script lang="ts">
  import { page } from '$app/state';
  import {
    connectWallet,
    connectedAccount,
    getActiveWallet,
    wallet
  } from '#lib/near/wallet.svelte';
  import { GAS } from '#lib/config';
  import { formatNear } from '#lib/near/amount';
  import { viewFunction } from '#lib/near/rpc';

  /**
   * Sign one transaction for the desktop app.
   *
   * The desktop app signs staking itself now: the contract dropped the
   * yoctoNEAR that made a real wallet signature mandatory. This page stays
   * for the sessions granted before that — their key does not list the
   * method, and nothing the app can do will add it — so they come here, the
   * same way they come here to connect, and the result goes home over
   * loopback.
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
    },
    buy_item: {
      label: 'Buy this and use it now',
      blurb: 'Paid in NEAR, and applied to the pet in the same transaction.'
    },
    mint: {
      label: 'Buy this accessory',
      blurb: 'It becomes a token you own: yours to put on a pet, or to sell.'
    },
    equip: {
      label: 'Put this on your pet',
      blurb: 'Both the accessory and the pet have to be yours. Nothing is spent.'
    },
    unequip: {
      label: 'Take this off',
      blurb: 'The accessory stays yours. Nothing is spent.'
    }
  } as const;

  /** Which contract each method is allowed to be aimed at. */
  const HOME = {
    stake_pet: /^jg-stake-[a-z0-9-]+\.(testnet|near)$/,
    unstake_pet: /^jg-stake-[a-z0-9-]+\.(testnet|near)$/,
    buy_item: /^jg-game-[a-z0-9-]+\.(testnet|near)$/,
    mint: /^jg-acc-[a-z0-9-]+\.(testnet|near)$/,
    equip: /^jg-acc-[a-z0-9-]+\.(testnet|near)$/,
    unequip: /^jg-acc-[a-z0-9-]+\.(testnet|near)$/
  } as const;

  type AccessoryKind = {
    slug: string;
    name: string;
    price: string;
    supply_cap: number;
    minted: number;
    art: string;
  };

  type ShopItem = {
    item_id: number;
    name: string;
    price: string;
    time_extension: number;
    xp: number;
    shield: number;
    is_revival: boolean;
  };

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
  const itemId = $derived(Number(params.get('item_id') ?? '0'));
  const kindSlug = $derived(params.get('kind') ?? '');
  const tokenId = $derived(params.get('token_id') ?? '');

  /**
   * The accessory's price, read from its contract for the same reason the
   * shop item's is: a link may say which hat, never what it costs.
   */
  let kind = $state<AccessoryKind | null>(null);

  $effect(() => {
    if (method !== 'mint' || !contractOk || !kindSlug) return;
    void viewFunction<AccessoryKind | null>(contractId, 'get_kind', { slug: kindSlug })
      .then((found) => (kind = found))
      .catch(() => (kind = null));
  });

  /**
   * What the item costs, read from the contract rather than from the link.
   *
   * The price is the one number here that moves money, so taking it from a
   * URL would make this page sign for whatever a link asked. The link may
   * choose *which* item; the chain says what it costs, and that is the figure
   * shown and the figure attached.
   */
  let item = $state<ShopItem | null>(null);
  let itemError = $state<string | null>(null);

  $effect(() => {
    if (method !== 'buy_item' || !contractOk || itemId <= 0) return;
    void viewFunction<ShopItem[]>(contractId, 'get_shop', {})
      .then((shop) => {
        item = shop.find((x) => x.item_id === itemId) ?? null;
        if (!item) itemError = `${contractId} has no item ${itemId}`;
      })
      .catch((error) => (itemError = error instanceof Error ? error.message : String(error)));
  });

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
  /** Each method may only be aimed at the contract it actually lives on. */
  const contractOk = $derived(
    known !== null && HOME[method as Method].test(contractId)
  );
  const needsItem = $derived(method === 'buy_item');
  const needsKind = $derived(method === 'mint');
  const needsToken = $derived(method === 'equip' || method === 'unequip');
  /** Only the pet-shaped calls need a pet. */
  const needsPet = $derived(method !== 'mint' && method !== 'unequip');

  const valid = $derived(
    known !== null &&
      contractOk &&
      target !== null &&
      (!needsPet || petId > 0) &&
      (!needsItem || item !== null) &&
      (!needsKind || kind !== null) &&
      (!needsToken || tokenId !== '')
  );

  $effect(() => {
    void connectedAccount().then((account) => {
      signedInAs = account;
      checked = true;
    });
  });

  // `connectWallet` resolves through the connector's event, not its return
  // value, so the page watches the store rather than awaiting the click.
  $effect(() => {
    if (wallet.accountId) signedInAs = wallet.accountId;
  });

  async function report(extra: Record<string, string>) {
    if (!target) return;
    target.searchParams.set('method', method);
    for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, value);

    const url = target.toString();
    returnUrl = url;

    // One call, not two: a fetch reaches the app without a navigation, which
    // https → http can block. Navigating as well would deliver the same
    // result twice, and the second arrival has nothing waiting for it.
    try {
      await fetch(url, { mode: 'no-cors' });
      return;
    } catch {
      window.location.href = url;
    }
  }

  /**
   * The contract's own sentence, not the envelope around it.
   *
   * A rejected call comes back as nested JSON — `{"index":0,"kind":{...
   * "ExecutionError":"Smart contract panicked: ..."}}` — and showing that
   * raw puts the one readable clause at the end of four lines of braces.
   */
  function readable(cause: unknown): string {
    const raw = cause instanceof Error ? cause.message : String(cause);
    const panic = raw.match(/Smart contract panicked:\s*([^"\\}]+)/);
    if (panic?.[1]) return panic[1].trim();
    const execution = raw.match(/"ExecutionError"\s*:\s*"([^"]+)"/);
    if (execution?.[1]) return execution[1].replace(/^Smart contract panicked:\s*/, '');
    return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
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
              args: needsItem
                ? { pet_id: petId, item_id: itemId }
                : needsKind
                  ? { kind: kindSlug }
                  : method === 'equip'
                    ? { token_id: tokenId, pet_id: petId }
                    : method === 'unequip'
                      ? { token_id: tokenId }
                      : { pet_id: petId },
              gas: GAS.heavy,
              // Staking takes none — the method is not payable any more, and a
              // non-payable method rejects a deposit rather than ignoring it.
              // Shop items cost exactly what the contract says they cost.
              /*
               * Minting also pays for the token's own storage, which the
               * contract works out after the mint and refunds the change
               * on. A tenth of a NEAR over the price covers it with room.
               */
              deposit: needsItem
                ? (item?.price ?? '0')
                : needsKind
                  ? (BigInt(kind?.price ?? '0') + 100_000_000_000_000_000_000_000n).toString()
                  : '0'
            }
          }
        ]
      });

      phase = 'done';
      await report({ tx_hash: outcome.transaction?.hash ?? 'unknown' });
    } catch (cause) {
      phase = 'error';
      message = readable(cause);
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
        {#if needsPet && petId <= 0}<li>· no pet named</li>{/if}
        {#if needsKind && kind === null}
          <li>· "{kindSlug || 'nothing'}" is not something that contract sells</li>
        {/if}
        {#if needsToken && tokenId === ''}<li>· no accessory named</li>{/if}
        {#if needsItem && item === null}
          <li>· {itemError ?? 'the item it names could not be read from the contract'}</li>
        {/if}
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
        {#if needsPet}
          <div class="flex justify-between gap-3 px-4 py-2">
            <dt class="text-muted">Pet</dt>
            <dd>#{petId}</dd>
          </div>
        {/if}
        {#if needsToken}
          <div class="flex justify-between gap-3 px-4 py-2">
            <dt class="text-muted">Accessory</dt>
            <dd>#{tokenId}</dd>
          </div>
        {/if}
        {#if kind}
          <!-- Name, art and price all read from the contract, not the link. -->
          <div class="flex items-center justify-between gap-3 px-4 py-2">
            <dt class="text-muted">Accessory</dt>
            <dd class="flex items-center gap-2">
              <img class="pixel h-6" alt="" src={kind.art} />
              {kind.name}
            </dd>
          </div>
          <div class="flex justify-between gap-3 px-4 py-2">
            <dt class="text-muted">How many exist</dt>
            <dd>
              {#if kind.supply_cap === 0}
                No limit
              {:else}
                {kind.minted} of {kind.supply_cap} minted
              {/if}
            </dd>
          </div>
        {/if}
        {#if item}
          <!-- Read from the contract, not from the link: see `item` above. -->
          <div class="flex justify-between gap-3 px-4 py-2">
            <dt class="text-muted">Item</dt>
            <dd>{item.name}</dd>
          </div>
          <div class="flex justify-between gap-3 px-4 py-2">
            <dt class="text-muted">It does</dt>
            <dd class="text-right">
              {#if item.time_extension}+{Math.round(item.time_extension / 3600)}h food{/if}
              {#if item.xp}{item.time_extension ? ', ' : ''}+{item.xp} XP{/if}
              {#if item.shield}, +{item.shield} shield{/if}
              {#if item.is_revival}, revives a starved pet{/if}
            </dd>
          </div>
        {/if}
        <div class="flex justify-between gap-3 px-4 py-2">
          <dt class="text-muted">It costs</dt>
          <dd class="text-accent">
            {#if item}
              {formatNear(item.price, 24)} NEAR
            {:else if kind}
              {formatNear(kind.price, 24)} NEAR, plus storage refunded as change
            {:else}
              Nothing but gas
            {/if}
          </dd>
        </div>
      </dl>

      <div class="flex gap-2 border-t border-line p-4 text-xs">
        <!--
          Connect first, when there is nothing to sign with.
          This button used to say "Sign it" whether or not a wallet was
          connected, and clicking it threw "Connect a wallet first" into the
          error state. From the app that reads as the button doing nothing,
          and it is almost certainly why a day's worth of transactions never
          reached the chain.
        -->
        {#if checked && !signedInAs && !wallet.accountId}
          <button
            class="flex-1 border border-accent bg-accent px-3 py-2 font-bold text-ink disabled:opacity-40"
            disabled={wallet.connecting}
            onclick={connectWallet}
          >
            {wallet.connecting ? 'Choose a wallet…' : 'Connect wallet first'}
          </button>
        {:else}
          <button
            class="flex-1 border border-accent bg-accent px-3 py-2 font-bold text-ink disabled:opacity-40"
            disabled={phase === 'signing' || !checked}
            onclick={sign}
          >
            {#if phase === 'signing'}
              Waiting for your wallet…
            {:else if !checked}
              Looking for your wallet…
            {:else}
              Sign it
            {/if}
          </button>
        {/if}
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
