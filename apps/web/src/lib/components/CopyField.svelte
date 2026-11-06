<script lang="ts">
  /**
   * A one-line value with a copy button — the install code and the command it
   * goes in.
   *
   * Copying is the whole point of this component, so it does not rely on the
   * clipboard API alone: in an insecure context (plain http on a LAN, which is
   * exactly how someone tries this from a second machine) `navigator.clipboard`
   * is undefined, and a copy button that silently does nothing is worse than no
   * button. The fallback selects the text so Cmd+C works.
   */
  type Props = { label: string; value: string; prefix?: string };
  let { label, value, prefix }: Props = $props();

  let copied = $state(false);
  let failed = $state(false);
  let field = $state<HTMLElement | null>(null);

  async function copy() {
    failed = false;
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(value);
      copied = true;
      setTimeout(() => (copied = false), 1600);
    } catch {
      failed = true;
      if (field) {
        const range = document.createRange();
        range.selectNodeContents(field);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }
</script>

<div class="flex flex-col gap-1">
  <span class="text-[0.65rem] tracking-widest text-muted uppercase">{label}</span>

  <div class="flex items-stretch border border-line bg-ink">
    <code
      bind:this={field}
      class="flex-1 overflow-x-auto px-3 py-2 text-xs whitespace-nowrap text-text"
    >
      {#if prefix}<span class="text-muted select-none">{prefix}</span>{/if}{value}
    </code>

    <button
      class="shrink-0 border-l border-line px-3 text-xs hover:bg-panel"
      class:text-accent={copied}
      onclick={copy}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  </div>

  {#if failed}
    <span class="text-[0.65rem] text-warn">
      The clipboard is blocked here — the text is selected, press Cmd/Ctrl+C.
    </span>
  {/if}
</div>
