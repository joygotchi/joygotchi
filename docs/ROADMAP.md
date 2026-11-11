# Where this is

Written down because the scope moved several times in one sitting, and the
difference between "built" and "built and reachable from the app" turned out to
be most of the remaining work.

## Live now

| | |
|---|---|
| Gallery | <https://joygotchi.vercel.app> — reads `jg-game-5656.testnet` directly, 8 pets |
| CLI | `@joygotchi/joygotchi@0.2.0` on GitHub Packages — `install`, `list`, `submit` |
| Contracts | game, pet-stake, mint-router on testnet; 212 Rust tests, hashes in [`DEPLOYED.md`](../contracts/DEPLOYED.md) |
| Desktop | Tauri 2, pixel-art game UI, hook server on `127.0.0.1:7777`; 218 TypeScript tests across the workspace |
| Pet speech | NEAR AI answers, reads the pet's real state, and may propose one action |
| Species | A row on chain, not a constant. Anyone can register one at `/create` |

Working end to end: connect a wallet → mint for 2 testnet NEAR → copy the
install code → `npx @joygotchi/joygotchi install <code>` (after the two
`npm config set` lines below — this fails with a bare `npx`) → the pet lands in
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

One left. The second entry below is not waiting on anything — it records a
decision and what it costs, because the question comes back otherwise.

1. **A 1Click *partner* key.** The one on hand is an `explorer` key, which the
   API will not accept for quotes. Without it, minting is NEAR-only — the
   mint-router is deployed and its wNEAR path is tested, so this is the only
   thing between here and paying with ZEC or SOL.

2. **What the CLI costs a newcomer to install.** Decided for now: it stays on
   GitHub Packages, published and public, and nothing is pending. This entry
   exists so the cost is written down rather than rediscovered.

   The cost is two `npm config set` lines per machine — one pointing the
   `@joygotchi` scope at GitHub, one with a GitHub token that has
   `read:packages`. A bare `npx @joygotchi/joygotchi` fails with a 404 from
   *npmjs*, which never mentions GitHub and reads like the package does not
   exist.

   Neither line is something configuration can remove. The repository is
   public and so is the package — and package visibility turned out to be a
   separate setting, which was the real reason nobody outside the org could
   install at all. With both public, an anonymous read of
   `npm.pkg.github.com` still answers `401 authentication token not
   provided`, and an `npx` run with an empty user config fails the same way.
   GitHub Packages authenticates reads of public npm packages.

   So "one command, no account" is not reachable here, by GitHub's design
   rather than ours. Publishing to npmjs as well is the only thing that
   reaches it, and it is a choice about who the CLI is for — not a chore
   that is overdue. It needs an npmjs login and the `@joygotchi` scope, and
   it is not worth doing until somebody outside this org actually wants to
   install a pet.

~~Make the repository public~~ — done; it is public, and Vercel now deploys on
push to `main`. It did not remove the token step, see above. ~~Buy NEAR AI
credits~~ — done; the chat endpoint returns real answers from `near-ai`, and a
pet asked to feed itself replies and proposes `{kind: "feed"}`.

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

Items 3, 4 and 5 are struck through: they were done on 2026-11-10 and -11.
What is left is 1, 2, 6 and 7, and 2 matters more than it did — a creator and
a player both now have something to sell and no way to sell it.

### 1. State viewer on the pet page (art)
The panel from the screenshot: every state, what triggers it, and a live
preview. Built against CSS motion it is useful immediately and becomes a true
frame viewer the day a pet has rows. Add `feeding` and `battling` to the state
vocabulary at the same time, so feeding a pet on the web makes the desktop pet
react.

### 2. The rest of the contract surface
`list_pet` / `buy_pet` (the NEAR pet market) and `list_item` / `buy_listing`
(the credit item market). Both deployed, both tested, neither reachable from
the app. `evolve` came off this list on 2026-11-10.

The item market has a rule that is easy to break while adding something
reasonable-looking: a session key may only spend prices the *contract* fixed,
and both halves of this market break that — `buy_listing` pays whatever a
seller asked and the seller can be the thief, `list_item` sells the kit for
nothing to an account they own. Neither has a ceiling. So this market needs
the wallet, not the session key, and `economy.test.ts` fails if those methods
are ever added to `STAKE_METHODS`.

`attack` came off this list on 2026-11-10, and how it came off is the warning
for the rest of it. It was reachable — there was a button, a roster and a
battle scene — and it still could not happen: a staked pet was refused a
fight, staking is the only way to earn credits, so of eight pets exactly one
was ever eligible and a fight needs two. Reachable is not the same as
possible, and nothing in the app said which one was missing.

### 3. ~~Feed actually raising XP~~ — done
`spend_credits` records the meal and `award_feed_xp` writes the XP, gated to an
oracle account. Both halves run: the web app grades a meal and the local oracle
verifies the purchase and signs. Graded for real on 2026-11-10, pet 8.

### 4. ~~The pet as an assistant~~ — done
Unblocked: NEAR AI answers now. Two things had to be true first — the model
must not be a reasoning one (it spent the whole token budget thinking and
returned nothing, as a successful 200), and the persona must read the pet's
real hunger rather than claiming it always wants food.

Built as decided: **the model proposes, the app decides.** It never holds a
key. Its reply is parsed into one of nine typed intents, and an intent carries
no pet, no amount and no account — `planIntent` asks the chain who owns what,
whether the pet is alive, whether the balance covers it and whether the session
key may sign it, then draws the card from its own numbers.

Nothing with a seller is proposable. Market prices are set by whoever lists,
and a session key may only spend prices the contract fixed, so the pet cannot
reach `buy_listing` at all.

A visitor is never offered the grammar — not filtered afterwards, never told it
exists — so somebody else's pet answers in character instead of refusing.

This mattered more than usual because a pet *name* is written by whoever minted
it and reaches the model. There is a test for the exact string.

### 5. ~~Submit your own pet~~ — done
A species is a row in a registry, registered by anyone for a fee, and
`CATEGORIES` is gone. Live since 2026-11-11.

Two ways in, and the second is the real one. `/create` recolours a drawing
this game ships, which is quick and is a recolour. `joygotchi submit
<folder>` takes a nine-row sprite atlas you drew anywhere — petdex's grid
unchanged, so a sheet made with their Hatch Pet skill drops in — and a pet
installed from one really animates per state rather than being moved around
in CSS.

Walked end to end on 2026-11-11, which is the only way to know it works:
`submit --into` wrote the sheets, the deploy served them, `create_species`
registered `reference` (`B4Ck5wPzHoKu25cjC7vkNvCZSRXToAE4ydedNPEMWmyh`),
`create_pet` minted ATLAS as pet 9
(`CUSPuYhQDv8NpwmbCAuFd7BkrTW8w6XhaPyRT1L5vS5Y`), and `joygotchi install
jg1_06vjq08a86dg` brought it down as a `spriteVersion: 2` package with its
8x9 atlas. The species doubles as the worked example of what the nine rows
should contain.

The part that had no answer in [`CREATE.md`](CREATE.md) was hosting: art has to
be at an https url and this project has no storage. It did not need any. Every
sprite is a GIF with a 16-entry global colour table and the frames reference it
by index, so a colourway is 48 bytes — rewrite the table, leave the rest of the
file alone, and the animation, frame delays and transparent index all survive.
`/api/species/art/<base>/<phase>.gif?h=&s=` is the whole of it. What goes on
chain is a recipe, not a file anyone has to keep alive.

It also fixed something older. Token `media` was a *relative* path, which
resolves only inside the desktop app, so every pet this game ever minted showed
in a wallet as a broken image. All eight were rewritten.

### 6. A creator earns nothing

The newest gap, and it was created by closing the last one. Anyone can
register a species and anyone can mint it, and `Species.minted` counts every
one — but it pays its creator nothing. The fee goes out, nothing comes back,
and the counter is a scoreboard with no prize.

Everything needed is already on chain: the mint is a payable call, the species
knows its `creator_id`, and `revenue_banked` already separates what was charged
from what is storage staking. A cut of the mint price, paid on `internal_mint`,
is a small change to a contract that just proved its migration path.

Decide the number before building it. Too small and nobody makes a second
species; too large and the treasury stops funding the credit stream that pays
staked pets — the two come out of the same payment.

### 7. The treasury's one off-chain step

`fund_epoch_from_reserve` means the credit stream can only emit what the
treasury actually bought. That is the point, and it is also the constraint: on
2026-11-11 the pool had paid out 93.35 credits against 48.96 ever purchased,
and the published rate was 500 a month against a reserve of 48.96.

It now streams 40 a month with 8.96 left for the faucet. Raising it is not a
number to edit — it is the treasury buying NEAR AI credits and calling
`fund_reserve`. Mint revenue reaches the treasury on its own now, through
`sweep_revenue`, which anyone may call.

## Loose ends

- **~~Contract source lives in two repositories.~~** Done, and it cost a live
  deployment to find out why it mattered: `pet-stake` built from this tree and
  deployed over `jg-stake-5656.testnet` left it unable to read its own state,
  because the other repository had added auto-feed fields to the struct. All
  three contracts now build from here to the hash the chain serves, recorded
  in [`contracts/DEPLOYED.md`](../contracts/DEPLOYED.md) with how to check
  before deploying and how to recover after. The old repository's PRs are
  closed.
- **Shields do not count towards staking weight.** Tried, reverted: the bonus
  meant adding a field to `PetAttrs`, which is stored inside every
  `StakedPet`, so it broke every staked record on the live contract. The
  design is sound and capped (+5% a shield, three maximum, one star's worth).

  Less blocked than it was. The species deploy on 2026-11-11 ran a real
  migration on the game contract and every pet came back, and
  `contracts/game/tests/migration.rs` is the pattern that made it safe: it
  deserialises the live `STATE` bytes with the layout `migrate` uses, and
  asserts the slice is consumed whole. A unit test cannot do that — it builds
  the old struct with the same compiler that reads it back, which is why both
  previous losses passed their tests. The same fixture test against
  `jg-stake-5656.testnet` is what this needs.
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
- **~~The desktop app installs no agent hooks.~~** Done. Settings writes them
  into the agent's own settings and repairs a stale install in place. The
  server logs what it receives, which is how you tell a hook that never fired
  from one that fired into a window that ignored it.
- **No signed desktop release.** It builds from source only.
