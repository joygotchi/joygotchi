<script lang="ts">
  import { truncateAccount } from '#lib/near/amount';
  import PetSprite from '#lib/components/PetSprite.svelte';
  import { artFor, type GalleryPet } from '#lib/pets';
  import { isStarving } from '@joygotchi/pet';

  type Props = { pet: GalleryPet };
  let { pet }: Props = $props();

  const rarityColour: Record<string, string> = {
    common: 'text-muted',
    rare: 'text-sky-300',
    epic: 'text-fuchsia-300',
    legendary: 'text-accent'
  };

  const starving = $derived(isStarving(pet));
</script>

<a
  class="group flex flex-col border border-line bg-panel transition-colors hover:border-line-bright"
  href="/pets/{pet.slug}"
>
  <div class="relative flex h-40 items-center justify-center bg-ink">
    <div class="transition-transform group-hover:scale-110">
      <PetSprite src={artFor(pet)} height={112} alt={pet.name} dim={starving} />
    </div>

    {#if pet.locked}
      <span class="absolute top-2 right-2 bg-panel-2 px-1.5 py-0.5 text-[0.6rem] text-warn">
        AT WORK
      </span>
    {:else if starving}
      <span class="absolute top-2 right-2 bg-panel-2 px-1.5 py-0.5 text-[0.6rem] text-bad">
        STARVED
      </span>
    {/if}

    {#if pet.star > 0}
      <span class="absolute bottom-2 left-2 text-[0.7rem] text-accent">
        {'★'.repeat(pet.star)}
      </span>
    {/if}
  </div>

  <div class="flex flex-col gap-1 border-t border-line px-3 py-2">
    <div class="flex items-baseline justify-between gap-2">
      <span class="truncate text-sm">{pet.name}</span>
      <span class="shrink-0 text-[0.65rem] text-muted">#{pet.pet_id}</span>
    </div>

    <div class="flex items-center justify-between text-[0.65rem]">
      <span class={rarityColour[pet.rarity] ?? 'text-muted'}>{pet.rarity}</span>
      <span class="text-muted">lv {pet.level}</span>
    </div>

    <span class="truncate text-[0.6rem] text-muted">{truncateAccount(pet.owner_id)}</span>
  </div>
</a>
