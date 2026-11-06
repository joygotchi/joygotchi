<div align="center">

<img src="apps/web/static/assets/animation/blackdragon/1.gif" alt="JOYGOTCHI" width="96" />

<h1>JOYGOTCHI</h1>

<p>
  A public gallery of pets that live on chain and on your desktop.
  <br />
  Mint one on NEAR, copy its install code, and it reacts to your coding agent.
</p>

</div>

---

## What this is

Three things that fit together:

1. **A web gallery** where every pet on the contract is a page, with the install code you copy.
2. **A CLI** that installs a pet from that code with one command, talking only to a NEAR RPC.
3. **A desktop app** that floats the pet over your editor and animates it on every tool call your
   coding agent makes. With NEAR AI configured it also says something about what just happened.

A pet is an NEP-171 token. The contract is the authority on who owns what, what rarity it rolled
and what level it reached, so nothing in this repository needs a database and there is no account
to make.

## Quick start

```sh
git clone https://github.com/joygotchi/joygotchi
cd joygotchi
pnpm install
pnpm dev          # the gallery on http://localhost:5173
```

Connect a wallet, mint a pet for 2 testnet NEAR, and the page hands you a code like
`jg1_06vwqsthtnk0`. Then:

```sh
node packages/cli/dist/index.js install jg1_06vwqsthtnk0
pnpm desktop
```

The pet lands in `~/.joygotchi/pets/<slug>/` and the desktop app picks it up.

## How installing works

The code carries the pet's token id and a checksum, and nothing else. It is not a secret and not a
capability — a pet is a token on a public chain, so a code that pretended to grant access would be
theatre. What it does is make an id copyable:

```
jg1_06vwqsthtnk0
 │   └── pet id, scattered across all four bytes, plus a CRC
 └────── format version
```

The id is scattered through a small reversible permutation so that neighbouring pets do not get
codes that look identical — the first cut encoded the id plainly and pets 1, 2 and 3 all read
`jg1_0400000…`, which is how people paste the wrong one. The checksum means a typo fails with
"that install code has a typo in it" rather than quietly installing somebody else's dragon.

`joygotchi install` then decodes the id, asks the contract for the pet, and writes what the
**contract** said — not what the code claimed. The art ships inside the npm package, so an install
needs no CDN, no registry of ours, and no second request that can fail halfway.

## Connecting a coding agent

The desktop app listens on `127.0.0.1:7777`. Any agent, any hook:

```sh
curl -s localhost:7777/event -d '{"kind":"tool-start","tool":"Bash"}'
```

Events are `tool-start`, `tool-end` (with `ok`), `prompt` and `idle`. The port is bound to loopback
and nothing authenticates, which is the whole security model: it cannot be reached from off the
machine.

## Layout

```text
joygotchi/
├── apps/
│   ├── web/          SvelteKit 3 · gallery, pet pages, mint, manifest and AI endpoints
│   └── desktop/      Tauri 2 · Rust shell, Svelte sprite renderer, hook server
├── packages/
│   ├── pet/          The pet package format, install codes, agent→state mapping
│   └── cli/          `joygotchi` — install, list, installed
├── contracts/        Rust · game (NEP-171 pets), pet-stake (AI credits), mint-router
└── docs/             ECONOMY.md, GAME_CONTRACT_V2.md
```

**Web**: SvelteKit 3, Svelte 5 runes, Tailwind 4, `@hot-labs/near-connect` for wallets.<br />
**Desktop**: Tauri 2 — Rust for the window, the hook server and the pet index; Svelte for what is
drawn.<br />
**CLI**: Node 20+, TypeScript, one dependency (the shared package).<br />
**Contracts**: near-sdk 5, built through `cargo near build`.

## The contracts

Deployed on testnet while NEAR Intents is not wired up:

| | |
|---|---|
| game | `jg-game-5656.testnet` |
| pet-stake | `jg-stake-5656.testnet` |
| mint-router | `jg-mint-5656.testnet` |

Minting here goes straight to `create_pet` and pays in NEAR. The `mint-router` path that takes ZEC
or SOL through 1Click settles into the same `create_pet_for`, so turning it on later changes
nothing a page does.

`docs/ECONOMY.md` covers the two-resource design — NEAR in, AI credit earned by staking pets and
spent on feeding, items and inference. `docs/GAME_CONTRACT_V2.md` is the contract spec and the
record of what has been run against testnet.

```sh
pnpm contracts:test     # 103 tests
pnpm contracts:build    # needs cargo-near >= 0.22
```

## NEAR AI

Two endpoints on the web app, both reading the pet off the chain so it cannot be described into
something it is not:

- `POST /api/ai/chat` — talk to a pet on its page.
- `POST /api/ai/react` — one line about what your agent just did, plus the state to animate.

Both need `NEAR_AI_API_KEY`. Without it they report themselves as unconfigured and everything else
— gallery, minting, installing, the desktop pet — keeps working.

## Development

```sh
pnpm check      # types across every package
pnpm test       # 62 tests across the JS packages
pnpm build

cd apps/desktop/src-tauri && cargo test    # 6 more, for the hook server and pet index
```

## Licence

MIT. Pet art belongs to its authors.
