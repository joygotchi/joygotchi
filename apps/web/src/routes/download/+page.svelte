<script lang="ts">
  import CopyField from '#lib/components/CopyField.svelte';
  import {
    ALL_RELEASES,
    DESKTOP_VERSION,
    DOWNLOADS,
    RELEASE_PAGE,
    downloadUrl,
    guessPlatform,
    type Platform
  } from '#lib/desktop';

  let platform = $state<Platform | null>(null);
  $effect(() => {
    platform = guessPlatform(navigator.userAgent);
  });

  const suggested = $derived(DOWNLOADS.find((one) => one.platform === platform) ?? null);
</script>

<section class="grid-bg -mx-4 border-b border-line px-4 py-10">
  <p class="text-xs tracking-widest text-muted uppercase">Desktop · v{DESKTOP_VERSION}</p>
  <h1 class="mt-2 max-w-2xl text-2xl leading-snug sm:text-3xl">
    Your pet, on top of your editor.
  </h1>
  <p class="mt-3 max-w-xl text-sm text-muted">
    A small transparent window that sits above your code. Your pet idles there and reacts to every
    tool call your coding agent makes — reading, running, failing, waiting — and with NEAR AI it
    says something about what just happened.
  </p>

  <div class="mt-6 flex flex-wrap items-center gap-2 text-xs">
    {#if suggested}
      <a class="bg-accent px-4 py-2.5 font-bold text-ink" href={downloadUrl(suggested)}>
        Download for {suggested.label}
      </a>
    {/if}
    <a class="border border-line px-4 py-2.5 hover:border-line-bright" href="#downloads">
      {suggested ? 'Other platforms' : 'Choose your platform'}
    </a>
  </div>
</section>

<section class="mt-8 scroll-mt-20" id="downloads">
  <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
    {#each DOWNLOADS as download (download.platform)}
      <a
        class="flex flex-col gap-1 border bg-panel p-4 transition-colors hover:border-line-bright"
        class:border-accent={download.platform === platform}
        class:border-line={download.platform !== platform}
        href={downloadUrl(download)}
      >
        <span class="text-sm" class:text-accent={download.platform === platform}>{download.label}</span>
        <span class="text-[0.65rem] text-muted">{download.detail}</span>
        <span class="mt-2 truncate text-[0.6rem] text-muted/70">{download.file}</span>
      </a>
    {/each}
  </div>
  <p class="mt-3 text-[0.65rem] text-muted">
    Also a <code class="text-text">.deb</code>, <code class="text-text">.rpm</code> and a Windows
    <code class="text-text">.msi</code> on the
    <a class="text-accent hover:underline" href={RELEASE_PAGE} rel="noreferrer" target="_blank"
      >release page</a
    >, and every earlier version under
    <a class="text-accent hover:underline" href={ALL_RELEASES} rel="noreferrer" target="_blank"
      >releases</a
    >.
  </p>
</section>

<div class="mt-8 grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
  <div class="border border-line bg-panel">
    <div class="border-b border-line px-4 py-3">
      <h2 class="text-sm tracking-widest text-muted uppercase">First launch</h2>
      <p class="mt-1 text-xs text-muted">
        The builds aren't code-signed yet, so your system asks once whether to trust them.
      </p>
    </div>
    <div class="flex flex-col gap-3 p-4 text-xs text-muted">
      <p>
        <span class="text-text">macOS</span> says the app is damaged or can't be opened. Drag it to
        Applications, then run this once:
      </p>
      <CopyField label="Allow it on macOS" prefix="$ " value="xattr -dr com.apple.quarantine /Applications/JOYGOTCHI.app" />
      <p>
        <span class="text-text">Windows</span> SmartScreen: click <em>More info</em>, then
        <em>Run anyway</em>.
      </p>
      <p>
        It starts in the bottom-right corner; drag it anywhere. Settings has a switch to let clicks
        fall through to the window underneath.
      </p>
    </div>
  </div>

  <div class="border border-line bg-panel">
    <div class="border-b border-line px-4 py-3">
      <h2 class="text-sm tracking-widest text-muted uppercase">Connect an agent</h2>
      <p class="mt-1 text-xs text-muted">
        The app listens on <code class="text-text">127.0.0.1:7777</code>. Point your agent's hooks
        at it and the pet reacts.
      </p>
    </div>

    <div class="flex flex-col gap-3 p-4">
      <CopyField
        label="Any agent, any hook"
        prefix="$ "
        value={`curl -s localhost:7777/event -H 'content-type: application/json' -d '{"kind":"tool-start","tool":"Bash"}'`}
      />
      <p class="text-[0.65rem] text-muted">
        Or let the app do it: Settings installs the hooks into your agent's own settings and
        repairs a stale install. Everything stays on your machine — the port is bound to loopback,
        so nothing off this machine can reach it.
      </p>
    </div>
  </div>
</div>
