<script lang="ts">
  import { atlasFrom, pngSize } from '@joygotchi/pet';
  import PetSprite from '#lib/components/PetSprite.svelte';
  import { sheetUrl, storageCost, storeSheet } from '#lib/art';
  import { formatNear } from '#lib/near/amount';
  import { wallet } from '#lib/near/wallet.svelte';
  import { createSpecies, getSpecies } from '#lib/pets';
  import { artUriError, MAX_SPECIES_NAME, speciesIdError } from '#lib/species';

  /**
   * Register a species from sheets you drew, with no pull request.
   *
   * The sheets are stored on chain (`contracts/art`) and served by this site
   * from there, so a creator needs a wallet and nothing else. It is the same
   * nine-row atlas `joygotchi submit` checks — that path still works for
   * people who would rather keep their art in the repository.
   */
  type Props = { price: string };
  let { price }: Props = $props();

  type Sheet = { bytes: Uint8Array; preview: string; size: string; cost: string };

  let id = $state('');
  let displayName = $state('');
  let sheets = $state<(Sheet | null)[]>([null, null, null]);
  let problems = $state<(string | null)[]>([null, null, null]);
  let busy = $state(false);
  let step = $state('');
  let error = $state<string | null>(null);
  let registered = $state<string | null>(null);

  const cleanId = $derived(
    id
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 24)
  );
  const cleanName = $derived(displayName.trim().slice(0, MAX_SPECIES_NAME));
  const idProblem = $derived(cleanId === '' ? null : speciesIdError(cleanId));
  const hostProblem = $derived(
    typeof location === 'undefined' ? null : artUriError(sheetUrl(location.origin, '0'.repeat(64)))
  );
  const filled = $derived(sheets.filter((sheet): sheet is Sheet => sheet !== null));
  /** Phases must be contiguous: 1, or 1–2, or 1–3. */
  const gap = $derived(sheets.findIndex((sheet) => !sheet) < sheets.findLastIndex((sheet) => !!sheet));
  const storage = $derived(
    filled.reduce((sum, sheet) => sum + BigInt(sheet.cost), 0n)
  );
  const ready = $derived(
    Boolean(wallet.accountId) &&
      cleanId !== '' &&
      !idProblem &&
      cleanName !== '' &&
      sheets[0] !== null &&
      !gap &&
      !hostProblem &&
      !busy
  );

  async function choose(index: number, event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    problems[index] = null;
    if (sheets[index]) URL.revokeObjectURL(sheets[index]!.preview);
    sheets[index] = null;
    if (!file) return;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const size = pngSize(bytes);
    if (!size) {
      problems[index] = 'That is not a PNG.';
      return;
    }
    const atlas = atlasFrom(file.name, size.width, size.height);
    if (!atlas.ok) {
      problems[index] = atlas.why;
      return;
    }
    if (bytes.length > 600 * 1024) {
      problems[index] = 'A sheet is at most 600 KB.';
      return;
    }
    sheets[index] = {
      bytes,
      preview: URL.createObjectURL(file),
      size: `${size.width}×${size.height}, ${Math.round(bytes.length / 1024)} KB`,
      cost: await storageCost(bytes.length).catch(() => '0')
    };
  }

  async function register() {
    if (!ready) return;
    busy = true;
    error = null;
    try {
      if (await getSpecies(cleanId)) throw new Error(`"${cleanId}" is taken. Pick another id.`);
      const urls: string[] = [];
      for (const [index, sheet] of filled.entries()) {
        step = `Storing sheet ${index + 1} of ${filled.length}…`;
        urls.push(sheetUrl(location.origin, await storeSheet(sheet.bytes)));
      }
      step = 'Registering the species…';
      await createSpecies(cleanId, cleanName, urls, price);
      registered = cleanId;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      step = '';
    }
  }
</script>

{#if registered}
  <p class="text-sm">
    <span class="text-accent">{cleanName}</span> is registered from your own sheets. Anyone can mint
    one now — find it once the first pet exists, or mint it yourself from any pet's page.
  </p>
{:else}
  <div class="grid gap-3 sm:grid-cols-3">
    {#each [0, 1, 2] as index (index)}
      <label
        class="flex cursor-pointer flex-col items-center gap-2 border border-dashed border-line bg-ink p-3 text-center text-[0.65rem] text-muted hover:border-line-bright"
      >
        {#if sheets[index]}
          <PetSprite src={sheets[index]!.preview} height={72} alt="Phase {index + 1}" />
          <span class="text-text">Phase {index + 1}</span>
          <span>{sheets[index]!.size}</span>
        {:else}
          <span class="py-6 text-text">Phase {index + 1}</span>
          <span>{index === 0 ? 'Required' : 'Optional'} · 8×9 PNG</span>
        {/if}
        <input class="sr-only" type="file" accept="image/png" onchange={(event) => choose(index, event)} />
      </label>
    {/each}
  </div>
  {#each problems as problem, index (index)}
    {#if problem}<p class="mt-2 text-xs text-bad">Phase {index + 1}: {problem}</p>{/if}
  {/each}
  {#if gap}<p class="mt-2 text-xs text-bad">Fill the phases in order: 1, then 2, then 3.</p>{/if}

  <div class="mt-4 grid gap-3 sm:grid-cols-2">
    <label class="block text-xs text-muted">
      Name
      <input
        class="mt-1 w-full border border-line bg-ink px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
        bind:value={displayName}
        placeholder="Azure Wyvern"
      />
    </label>
    <label class="block text-xs text-muted">
      Id <span class="text-muted/60">· lowercase, permanent</span>
      <input
        class="mt-1 w-full border bg-ink px-3 py-2 text-sm text-text focus:outline-none"
        class:border-bad={idProblem}
        class:border-line={!idProblem}
        bind:value={id}
        placeholder="wyvern"
      />
    </label>
  </div>
  {#if idProblem}<p class="mt-1 text-xs text-bad">{idProblem}</p>{/if}
  {#if hostProblem}<p class="mt-2 text-xs text-bad">{hostProblem} — register from the live site.</p>{/if}

  {#if wallet.accountId}
    <button
      class="mt-4 w-full bg-accent px-3 py-2.5 text-sm font-bold text-ink disabled:opacity-40"
      disabled={!ready}
      onclick={register}
      type="button"
    >
      {busy ? step : `Store ${filled.length || ''} sheet${filled.length === 1 ? '' : 's'} and register for ${price} NEAR`}
    </button>
    <p class="mt-2 text-center text-[0.65rem] text-muted">
      {#if filled.length > 0}
        Plus about {formatNear(storage, 3)} NEAR for the sheets' storage on chain, paid once. One
        wallet signature per sheet, then one for the species.
      {:else}
        The sheets are stored on NEAR, so you pay their storage once and nobody has to host them.
      {/if}
    </p>
  {:else}
    <p class="mt-4 text-xs text-muted">Connect a wallet to register a species.</p>
  {/if}

  {#if error}
    <p class="mt-3 border border-bad/40 bg-bad/10 p-2 text-xs text-bad">{error}</p>
  {/if}
{/if}
