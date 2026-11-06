<script lang="ts">
  import CopyField from '#lib/components/CopyField.svelte';
  import { CLI_PACKAGE, SETUP_REGISTRY, SETUP_TOKEN, TOKEN_URL } from '#lib/cli';
</script>

<h1 class="text-xl">JOYGOTCHI Desktop</h1>
<p class="mt-2 max-w-xl text-sm text-muted">
  A small transparent window that sits above your editor. Your pet idles there, and animates on
  every tool call your coding agent makes — reading, running, failing, waiting. With NEAR AI
  configured it also says something about what just happened.
</p>

<div class="mt-8 grid gap-4 lg:grid-cols-2">
  <div class="border border-line bg-panel">
    <div class="border-b border-line px-4 py-3">
      <h2 class="text-sm tracking-widest text-muted uppercase">Build it</h2>
      <p class="mt-1 text-xs text-muted">
        No signed releases yet, so it builds from source. Rust and Node are the only requirements —
        Tauri pulls the rest.
      </p>
    </div>

    <div class="flex flex-col gap-3 p-4">
      <CopyField
        label="Clone and run"
        prefix="$ "
        value="git clone https://github.com/joygotchi/joygotchi && cd joygotchi && pnpm install && pnpm desktop"
      />
      <p class="text-[0.65rem] text-muted">
        macOS, Linux and Windows. The window is click-through except over the pet itself.
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
        value={`curl -s localhost:7777/event -d '{"kind":"tool-start","tool":"Bash"}'`}
      />
      <p class="text-[0.65rem] text-muted">
        Settings in the app installs this for Claude Code and Codex with one click each. Everything
        stays on your machine: the port is bound to loopback.
      </p>
    </div>
  </div>
</div>

<div class="mt-8 border border-line bg-panel">
  <div class="border-b border-line px-4 py-3">
    <h2 class="text-sm tracking-widest text-muted uppercase">Install a pet</h2>
    <p class="mt-1 text-xs text-muted">
      Copy the install code from any pet's page and run the command it shows. The pet lands in
      <code class="text-text">~/.joygotchi/pets/</code> and the app finds it there.
    </p>
  </div>

  <div class="flex flex-col gap-3 p-4">
    <p class="text-xs text-muted">
      Two commands first, once per machine. <code class="text-text">{CLI_PACKAGE}</code> is
      published to GitHub Packages, and npm looks for a scoped name on npmjs unless told
      otherwise — that part is not a visibility setting and does not go away.
    </p>
    <CopyField label="Point the scope at GitHub" prefix="$ " value={SETUP_REGISTRY} />

    <p class="text-xs text-muted">
      The package is private while the repository is, so npm also needs a GitHub token with
      <code class="text-text">read:packages</code> —
      <a class="text-accent hover:underline" href={TOKEN_URL} rel="noreferrer" target="_blank">
        make one here</a>. This step is the one that disappears when the repository goes public.
    </p>
    <CopyField label="Give npm a token" prefix="$ " value={SETUP_TOKEN} />
  </div>
</div>
