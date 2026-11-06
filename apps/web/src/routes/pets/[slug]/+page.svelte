<script lang="ts">
  import { page } from '$app/state';
  import CopyField from '#lib/components/CopyField.svelte';
  import { SETUP_REGISTRY, SETUP_TOKEN, TOKEN_URL, installCommand } from '#lib/cli';
  import PetActions from '#lib/components/PetActions.svelte';
  import PetChat from '#lib/components/PetChat.svelte';
  import { explorerAccount, explorerToken } from '#lib/config';
  import { truncateAccount } from '#lib/near/amount';
  import { wallet } from '#lib/near/wallet.svelte';
  import { getPetBySlug, type GalleryPet } from '#lib/pets';
  import { isStarving } from '@joygotchi/pet';

  let pet = $state<GalleryPet | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const slug = $derived(page.params.slug ?? '');

  /**
   * Read the pet again. Called on mount and after an action that changes it,
   * so a stake or a level-up shows without a refresh — and guarded on the slug
   * so a slow request for the previous pet cannot overwrite the current one.
   */
  async function reload(wanted = slug) {
    try {
      const found = await getPetBySlug(wanted);
      if (slug !== wanted) return;
      pet = found;
      error = found ? null : 'No pet at this address.';
    } catch (cause) {
      if (slug === wanted) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (slug === wanted) loading = false;
    }
  }

  $effect(() => {
    loading = true;
    error = null;
    void reload(slug);
  });

  const mine = $derived(Boolean(pet && wallet.accountId === pet.owner_id));
  const starving = $derived(pet ? isStarving(pet) : false);
</script>

<svelte:head>
  <title>{pet ? `${pet.name} · JOYGOTCHI` : 'JOYGOTCHI'}</title>
</svelte:head>

<a class="text-xs text-muted hover:text-text" href="/">← Gallery</a>

{#if loading}
  <div class="mt-4 h-96 animate-pulse border border-line bg-panel"></div>
{:else if error || !pet}
  <div class="mt-4 border border-line bg-panel p-8 text-sm text-muted">
    {error ?? 'No pet at this address.'}
  </div>
{:else}
  <div class="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]">
    <!-- Art and stats -->
    <div class="flex flex-col gap-4">
      <div class="grid-bg flex h-72 items-center justify-center border border-line bg-panel">
        <img
          class="pixel h-48"
          class:opacity-40={starving}
          alt={pet.name}
          src="/assets/animation/{pet.pkg.states.idle}"
        />
      </div>

      <div class="border border-line bg-panel">
        <div class="flex items-baseline justify-between border-b border-line px-3 py-2">
          <span class="text-lg">{pet.name}</span>
          <span class="text-xs text-muted">#{pet.pet_id}</span>
        </div>

        <dl class="divide-y divide-line text-xs">
          {#each [
            ['Rarity', pet.rarity],
            ['Kind', pet.kind],
            ['Level', String(pet.level)],
            ['Stars', pet.star > 0 ? '★'.repeat(pet.star) : '—'],
            ['Phase', String(pet.pkg.evolutionPhase)],
            ['Owner', truncateAccount(pet.owner_id)],
            ['Status', pet.locked ? 'At work in the AI Lab' : starving ? 'Starved' : 'Happy']
          ] as const as [label, value] (label)}
            <div class="flex justify-between gap-3 px-3 py-2">
              <dt class="text-muted">{label}</dt>
              <dd class="truncate">{value}</dd>
            </div>
          {/each}
        </dl>
      </div>

      <div class="flex gap-2 text-xs">
        <a
          class="flex-1 border border-line px-3 py-2 text-center text-muted hover:border-line-bright"
          href={explorerToken(pet.pet_id)}
          rel="noreferrer"
          target="_blank"
        >
          This pet on the explorer
        </a>
        <a
          class="flex-1 border border-line px-3 py-2 text-center text-muted hover:border-line-bright"
          href={explorerAccount(pet.owner_id)}
          rel="noreferrer"
          target="_blank"
        >
          Its owner
        </a>
      </div>
    </div>

    <!-- Install and talk -->
    <div class="flex flex-col gap-4">
      <div class="border border-line bg-panel">
        <div class="border-b border-line px-4 py-3">
          <h2 class="text-sm tracking-widest text-muted uppercase">Install</h2>
          <p class="mt-1 text-xs text-muted">
            The code is the pet's id in a form you can copy without mistyping. The CLI decodes it,
            asks the contract who owns the pet, and writes it to
            <code class="text-text">~/.joygotchi/pets/{pet.slug}/</code>.
          </p>
        </div>

        <div class="flex flex-col gap-4 p-4">
          <CopyField label="Install code" value={pet.pkg.installCode} />
          <CopyField label="Install it" prefix="$ " value={installCommand(pet.pkg.installCode)} />

          <details class="border border-line bg-ink">
            <summary class="cursor-pointer px-3 py-2 text-[0.65rem] text-warn">
              First time on this machine? Two one-time commands →
            </summary>

            <div class="flex flex-col gap-3 border-t border-line p-3">
              <p class="text-[0.65rem] text-muted">
                The CLI is published to GitHub Packages, and npm looks for a scoped name on
                npmjs unless you tell it otherwise.
              </p>
              <CopyField label="Point the scope at GitHub" prefix="$ " value={SETUP_REGISTRY} />

              <p class="text-[0.65rem] text-muted">
                The package is private while the repository is, so npm also needs a GitHub token
                with <code class="text-text">read:packages</code> —
                <a class="text-accent hover:underline" href={TOKEN_URL} rel="noreferrer" target="_blank">
                  make one here
                </a>.
              </p>
              <CopyField label="Give npm a token" prefix="$ " value={SETUP_TOKEN} />
            </div>
          </details>

          <p class="text-[0.65rem] text-muted">
            Then open the desktop app and pick {pet.name} under Pets.
            <a class="text-accent hover:underline" href="/download">Get it here.</a>
          </p>
        </div>
      </div>

      {#if mine}
        <PetActions {pet} onchanged={() => reload()} />
      {/if}

      <PetChat {pet} {mine} />
    </div>
  </div>
{/if}
