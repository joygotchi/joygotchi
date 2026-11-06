# Where this is

Written down because the scope moved several times in one sitting, and the
difference between "built" and "built and reachable from the app" turned out to
be most of the remaining work.

## Live now

| | |
|---|---|
| Gallery | <https://joygotchi.vercel.app> — reads `jg-game-5656.testnet` directly, 5 pets |
| CLI | `@joygotchi/joygotchi@0.1.0` on GitHub Packages |
| Contracts | game, pet-stake, mint-router on testnet; 119 tests |
| Desktop | Tauri 2, builds and runs, hook server on `127.0.0.1:7777` |

Working end to end: connect a wallet → mint for 2 testnet NEAR → copy the
install code → `npx @joygotchi/joygotchi install <code>` → the pet lands in
`~/.joygotchi/pets/` → the desktop app shows it and animates on agent events.
Staking, claiming, the faucet, mining, and buying and using all four items work
from the pet page.

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

### 3. Feed actually raising XP
`spend_credits` records the meal; `award_feed_xp` on pet-stake writes the XP and
is gated to an oracle account. The route and the key handling exist in the
other repository (PR #15 there) and need porting here.

### 4. The pet as an assistant
Chat with tool calls: balance, transfers, payments, and the economy actions
above. Decided: **the model proposes, the user signs.** It never holds a key.
Its output is parsed into a typed intent, validated against our own rules, and
rendered as a confirmation our code draws from the validated data — never from
model text. This matters more than usual here because the pet reads on-chain
data and agent output, so a pet *name* is attacker-controlled input.

### 5. Submit your own pet (art)
The creator flow from the second screenshot: upload a sprite, get a pet other
people can mint, with attribution and stats. Needs asset storage, a review
step, and a contract that can take a new category — today `CATEGORIES` is two
hardcoded dragons. The largest item here and the one that most needs its own
design pass.

## Loose ends

- **Contract source lives in two repositories.** `jg-game-5656.testnet` matches
  this one, including the NEP-171 fix. `joygotchi-near-client-bot` does not,
  and has PRs #14, #15 and #17 open. Pick one and close the other out.
- **The desktop app installs no agent hooks.** Settings documents a `curl`; the
  one-click-per-agent install that makes the pet react while you work is not
  written.
- **No signed desktop release.** It builds from source only.
