# Where this is

Written down because the scope moved several times in one sitting, and the
difference between "built" and "built and reachable from the app" turned out to
be most of the remaining work.

## Live now

| | |
|---|---|
| Gallery | <https://joygotchi.vercel.app> — reads `jg-game-5656.testnet` directly, 8 pets |
| CLI | `@joygotchi/joygotchi@0.1.0` on GitHub Packages |
| Contracts | game, pet-stake, mint-router on testnet; 139 Rust tests, hashes in [`DEPLOYED.md`](../contracts/DEPLOYED.md) |
| Desktop | Tauri 2, pixel-art game UI, hook server on `127.0.0.1:7777`; 87 TypeScript tests |
| Pet speech | NEAR AI answers, and reads the pet's real state to do it |

Working end to end: connect a wallet → mint for 2 testnet NEAR → copy the
install code → `npx @joygotchi/joygotchi install <code>` → the pet lands in
`~/.joygotchi/pets/` → the desktop app shows it and animates on agent events.
Staking, claiming, the faucet, mining, battling, and buying and using all four
items work from the desktop app, which is where the controls live — the
gallery is a read-only window onto the same chain.

Everything but staking signs on the machine with a session key. Staking is no
longer the exception by protocol — the contract dropped the yoctoNEAR that
forced a wallet signature — but a key granted before that change cannot be
widened, so those sessions still take the browser route until they reconnect.

A fight somebody else starts shows itself: the window polls the pets and pairs
the two sides by the timestamp the contract stamps on both, so no indexer is
needed to know who attacked you and whether you won.

## Waiting on a decision, not on work

Each is one command or one purchase, and each unblocks something real.

1. **Make the repository public.**
   ```sh
   gh repo edit joygotchi/joygotchi --visibility public --accept-visibility-change-consequences
   ```
   Removes the GitHub token step from installing, and lets Vercel deploy on
   push — its Hobby plan refuses to connect to a private repo owned by an
   organisation. The git history has been scanned: no `.env`, `.npmrc`, key or
   token was ever committed.

2. **Buy NEAR AI credits** at cloud.near.ai. The key is configured and
   accepted; the account has no spending limit, so every call returns
   `402 No spending limit configured`. Until then the pet cannot talk and the
   desktop pet animates without a line.

3. **A 1Click *partner* key.** The one on hand is an `explorer` key, which the
   API will not accept for quotes. Without it, minting is NEAR-only — the
   mint-router is deployed and its wNEAR path is tested, so this is the only
   thing between here and paying with ZEC or SOL.

## The gap that shapes everything else

**Our pets have one drawing each, and petdex pets have nine.**

A petdex pet is an 8×9 sprite atlas: one row per state, six to eight frames
each. Ours is a single idle GIF per evolution phase, and `toPetPackage` points
all nine states at it. The desktop app tells states apart with CSS motion over
that one loop — a real difference, but not animation.

Everything below marked (art) is limited by this, and there are three ways out:

- **Keep CSS motion.** Free, works today, honest. A state viewer shows what the
  desktop pet actually does rather than nine identical GIFs.
- **Draw or generate nine rows per pet.** The real fix; the cost is art.
- **Adopt petdex's atlas format.** `frame` and `spriteVersion` are already in
  `pet.json` for this reason — a petdex-shaped atlas would drop straight in,
  and their gallery becomes a source of pets.

## Next, in the order I would do it

### 1. State viewer on the pet page (art)
The panel from the screenshot: every state, what triggers it, and a live
preview. Built against CSS motion it is useful immediately and becomes a true
frame viewer the day a pet has rows. Add `feeding` and `battling` to the state
vocabulary at the same time, so feeding a pet on the web makes the desktop pet
react.

### 2. The rest of the contract surface
`attack` (battles), `list_pet` / `buy_pet` (the NEAR pet market), `list_item` /
`buy_listing` (the credit item market), `evolve`. All deployed, all tested, none
reachable from the app.

### 3. ~~Feed actually raising XP~~ — done
`spend_credits` records the meal and `award_feed_xp` writes the XP, gated to an
oracle account. Both halves run: the web app grades a meal and the local oracle
verifies the purchase and signs. Graded for real on 2026-11-10, pet 8.

### 4. The pet as an assistant
Unblocked: NEAR AI answers now. Two things had to be true first — the model
must not be a reasoning one (it spent the whole token budget thinking and
returned nothing, as a successful 200), and the persona must read the pet's
real hunger rather than claiming it always wants food.

Chat with tool calls: balance, transfers, payments, and the economy actions
above. Decided: **the model proposes, the user signs.** It never holds a key.
Its output is parsed into a typed intent, validated against our own rules, and
rendered as a confirmation our code draws from the validated data — never from
model text. This matters more than usual here because the pet reads on-chain
data and agent output, so a pet *name* is attacker-controlled input.

### 5. Submit your own pet (art)
The creator flow from the second screenshot. Designed now in
[`CREATE.md`](CREATE.md), from reading how petdex does it: the thing a creator
submits here is not a pet but a **species** others mint, and `CATEGORIES` is a
two-element `const` in the game contract, so nothing uploaded can be minted
until that becomes stored state. Still the largest item.

## Loose ends

- **~~Contract source lives in two repositories.~~** Done, and it cost a live
  deployment to find out why it mattered: `pet-stake` built from this tree and
  deployed over `jg-stake-5656.testnet` left it unable to read its own state,
  because the other repository had added auto-feed fields to the struct. All
  three contracts now build from here to the hash the chain serves, recorded
  in [`contracts/DEPLOYED.md`](../contracts/DEPLOYED.md) with how to check
  before deploying and how to recover after. `joygotchi-near-client-bot` still
  has PRs #14, #15 and #17 open against its copy; close them out there.
- **Shields do not count towards staking weight.** Tried, reverted: the bonus
  meant adding a field to `PetAttrs`, which is stored inside every
  `StakedPet`, so it broke every staked record on the live contract. The
  design is sound and capped (+5% a shield, three maximum, one star's worth)
  — it needs the shield passed alongside `PetAttrs` rather than inside it, or
  a migration. See [`contracts/DEPLOYED.md`](../contracts/DEPLOYED.md).
- **~~Auto-feed could never have worked.~~** `auto_feed` on the staking
  contract calls `feed_from_stake` on the game contract, and the game
  contract did not have it — the feature spans both and only one half was
  ever deployed here. Ported and live, which also unblocked `feed_pet`.
- **~~Nothing runs the feed oracle.~~** Done, both halves. `apps/oracle` polls
  for accounts with auto-feed on and buys the meals their budgets allow, and it
  grades meals on a loopback port and pays their XP. It runs as a login agent
  with one function-call key for `auto_feed` and `award_feed_xp`.

  Event discovery turned out not to be needed: the app already knows the
  transaction hash, and a hash is a pointer at the chain rather than a claim —
  the pet, the account and the lens all come from the receipts. The signing
  sits with the oracle rather than the web app, so no key that writes to the
  contract has to live on a rented host.
- **The desktop app installs no agent hooks.** Settings documents a `curl`; the
  one-click-per-agent install that makes the pet react while you work is not
  written.
- **No signed desktop release.** It builds from source only.
