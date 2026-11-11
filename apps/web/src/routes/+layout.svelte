<script lang="ts">
  import '../app.css';
  import WalletButton from '#lib/components/WalletButton.svelte';
  import { NETWORK } from '#lib/config';
  import { page } from '$app/state';

  let { children } = $props();

  const nav = [
    { href: '/', label: 'Gallery' },
    { href: '/me', label: 'My pets' },
    { href: '/create', label: 'Create' },
    { href: '/download', label: 'Desktop' }
  ];

  const isActive = (href: string) =>
    href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
</script>

<div class="flex min-h-screen flex-col">
  <header class="sticky top-0 z-10 border-b border-line bg-ink/95 backdrop-blur">
    <div class="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3">
      <a class="flex items-center gap-2" href="/">
        <img class="pixel h-7" alt="" src="/assets/animation/blackdragon/1.gif" />
        <span class="text-sm font-bold tracking-widest">JOYGOTCHI</span>
      </a>

      {#if NETWORK !== 'mainnet'}
        <span class="border border-line px-1.5 py-0.5 text-[0.6rem] tracking-wider text-warn">
          {NETWORK.toUpperCase()}
        </span>
      {/if}

      <nav class="ml-auto hidden gap-1 sm:flex">
        {#each nav as item (item.href)}
          <a
            class="px-3 py-2 text-xs hover:text-text"
            class:text-muted={!isActive(item.href)}
            class:text-accent={isActive(item.href)}
            href={item.href}
          >
            {item.label}
          </a>
        {/each}
      </nav>

      <div class="ml-auto flex items-center gap-2 sm:ml-0">
        <WalletButton />
      </div>
    </div>

    <nav class="flex border-t border-line sm:hidden">
      {#each nav as item (item.href)}
        <a
          class="flex-1 py-2 text-center text-xs"
          class:text-muted={!isActive(item.href)}
          class:text-accent={isActive(item.href)}
          href={item.href}
        >
          {item.label}
        </a>
      {/each}
    </nav>
  </header>

  <main class="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
    {@render children()}
  </main>

  <footer class="border-t border-line">
    <div
      class="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-4 text-[0.65rem] text-muted"
    >
      <span>Pets live on NEAR {NETWORK}.</span>
      <a class="hover:text-text" href="/api/manifest">Manifest API</a>
      <a class="hover:text-text" href="https://github.com/joygotchi/joygotchi">Source</a>
    </div>
  </footer>
</div>
