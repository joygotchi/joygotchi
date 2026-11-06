<script lang="ts">
  import type { GalleryPet } from '#lib/pets';

  /**
   * Talk to a pet through NEAR AI.
   *
   * Read-only on purpose for now: the endpoint spends no credits and writes
   * nothing on chain, so anybody can say hello to any pet. The metered path —
   * `spend_credits` on the staking contract, then a server that verifies the
   * receipt before it will run inference — is what `ai_feed` needs, and it
   * needs the staking UI that is not in this app yet. Until then the chat is
   * free and the limits are the model's.
   */
  type Props = { pet: GalleryPet; mine: boolean };
  let { pet, mine }: Props = $props();

  type Turn = { from: 'you' | 'pet'; text: string };

  let message = $state('');
  let turns = $state<Turn[]>([]);
  let thinking = $state(false);
  let unavailable = $state<string | null>(null);

  async function send() {
    const text = message.trim();
    if (!text || thinking) return;

    turns = [...turns, { from: 'you', text }];
    message = '';
    thinking = true;

    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ petId: pet.pet_id, message: text })
      });

      const body = (await response.json()) as { reply?: string; error?: string };

      if (response.status === 503) {
        unavailable = body.error ?? 'The AI is not configured on this deployment.';
        return;
      }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);

      turns = [...turns, { from: 'pet', text: body.reply ?? '…' }];
    } catch (cause) {
      turns = [
        ...turns,
        { from: 'pet', text: cause instanceof Error ? cause.message : String(cause) }
      ];
    } finally {
      thinking = false;
    }
  }
</script>

<div class="flex flex-col border border-line bg-panel">
  <div class="border-b border-line px-4 py-3">
    <h2 class="text-sm tracking-widest text-muted uppercase">Talk to {pet.name}</h2>
    <p class="mt-1 text-xs text-muted">
      Runs on NEAR AI. It knows its own stats and {mine ? 'that you are its owner' : "that you are a visitor"}.
    </p>
  </div>

  {#if unavailable}
    <p class="px-4 py-6 text-xs text-warn">{unavailable}</p>
  {:else}
    <div class="flex max-h-72 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 text-xs">
      {#if turns.length === 0}
        <p class="text-muted">Say something. It has been waiting.</p>
      {/if}

      {#each turns as turn, index (index)}
        <div class="flex gap-2" class:flex-row-reverse={turn.from === 'you'}>
          {#if turn.from === 'pet'}
            <img class="pixel h-8 shrink-0" alt="" src="/assets/animation/{pet.pkg.states.idle}" />
          {/if}
          <p
            class="max-w-[80%] px-2 py-1.5"
            class:bg-ink={turn.from === 'pet'}
            class:bg-panel-2={turn.from === 'you'}
          >
            {turn.text}
          </p>
        </div>
      {/each}

      {#if thinking}
        <p class="text-muted">{pet.name} is thinking…</p>
      {/if}
    </div>

    <form
      class="flex border-t border-line"
      onsubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <input
        class="flex-1 bg-ink px-3 py-2 text-xs outline-none"
        maxlength="280"
        placeholder="How was your day?"
        bind:value={message}
      />
      <button
        class="border-l border-line px-3 text-xs hover:bg-panel-2 disabled:opacity-40"
        disabled={thinking || message.trim() === ''}
        type="submit"
      >
        Send
      </button>
    </form>
  {/if}
</div>
