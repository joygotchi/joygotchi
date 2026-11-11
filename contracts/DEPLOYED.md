# What is actually deployed

The three testnet contracts, and the hash each one should build to from this
repository. Every entry here has been checked by building the source in this
tree and comparing with what the chain serves.

| Account | Code hash (bs58 of the SHA-256) |
| --- | --- |
| `jg-game-5656.testnet` | `72t8eWA12XeupTZUWpcTToE7kaEzqos4X9S7mvDnig81` |
| `jg-stake-5656.testnet` | `HLSqm66yR8hs12S9tBqCr6FFSeajeoY2RV3FkjNKDQjC` |
| `jg-mint-5656.testnet` | `8J2feEm9mKq5oMhm3Bhw25iWCwWHHbdn8DipbsR85vM9` |
| `jg-acc-5656.testnet` | `2Vo9WPe79wKz2faxk4BFXyASHg93GMNeBE4jTuGBbK94` |

Both were redeployed on 2026-11-10 to move the game onto one currency: credits
revive a pet (`revive_pet` → `revive_from_stake`), feeding spends the Focus
Lens and rolls for drops, and `spend_credits` refuses an action that has a
call of its own. The previous pair was
`8ozFwCvfMRn4vakW6bpETHXdJwaniAzYEu5BkRGRzSWL` (game) and
`Gd4A7eMoyVtrZ6s6PEYXMhHPABXEUXPgq5ydNWzfKRqC` (stake), at block 277052299.

That deploy added only methods, constants and event fields — no field was
added to any stored struct, which is why it went out `without-init-call` and
kept its state. `get_staked_pets` was read immediately afterwards and still
returns `attrs` and `staked_at` correctly, which is the check the section
below exists for.

Redeployed again the same day so that a pet at work can fight. The rule
refusing it sat in three places — `attack` on the game contract,
`is_attackable` here, and an explicit `!is_staked(winner)` in
`report_battle` — and because staking is the only way to earn credits, it
left no legal pairing anywhere: one of eight pets was both alive and
unlocked, and a fight needs two with different owners. Removing it from one
contract would have been worse than leaving it, since the battle would roll
on the game side and then be rejected in settlement.

Wards and wounds still protect; `locked` still blocks transfer, which is all
DECISION 3 ever claimed it was for. Code only again, no stored struct
touched. Previous pair: `3Vt83sgUhhi4dLBeaop1wo7fai7Nn8csUhcfhMntZo7s` and
`6qpqe8fkZe6Jkg5dai2JHm1bQmWtVnQCDabfJdoxi32C`.

Redeployed once more for `evolve_pet` → `evolve_from_stake`. The staking
contract has priced `evolve` at 500,000 micro-credits since the sinks were
seeded, and nothing joined that price to `evolve` on the game contract — so
the dearest action in the game, thirty-three meals, charged and did nothing.
The third instance of that fault after `revive` and `feed`; `spend_credits`
now refuses all three by name. Code only, no stored struct touched. Previous
pair: `62EzQeJfY8Y8x4bxTPkgnub7ewT8VS4M6584Auiv7oCN` and
`81Dbt6scc68L5L3BWnsU6VTWcqbEFrdcTa6WACsWbNK4`.

Redeployed on 2026-11-12 for the gameplay round (G1–G5). Every hash below
is what `./build.sh` produces from this commit:

| Account | Code hash | How |
|---|---|---|
| `jg-game-5656.testnet` | `2qMDZtWmf3h1MaeBpAeTa5jPeLcK8HCBEX5GxfGjEaep` | code only |
| `jg-mint-5656.testnet` | `3pcUJneX9huK6ikfp13b8RMxTR6cixCTrjF1c1LSuCRa` | code only (no mint was pending) |
| `jg-stake-5656.testnet` | `5xWtpAPeJg23jjQuierPmLXPwFUsK9SYwC1h4kBnXc5A` | `with-init-call migrate_epochs`, `FgWn4i8urr7KqDZd15Nj2WPV66nXTEwtg3JcbkPkwu5h` |
| `art.jg-game-5656.testnet` | `3sJMRNLu6qxYc9YC3jvUNG6av9nww7F1h8m6XC5GAsRY` | new, `with-init-call new` |

- **Router royalty (G1).** The router unwraps the wNEAR a bridge delivers and
  pays `create_pet_for` with it, so a species' creator gets 1% of a
  multichain mint too, and it accepts any registered species rather than the
  two shipped ones. Walked on chain: `wrap.testnet ft_transfer_call` to the
  router minted pet 12 BRIDGED (`BKPHQnajj4iRb7sHCq24xKbMnuLccwMf1okKkiki4ToL`)
  and `revenue_banked` rose by exactly the 2 NEAR. The swap leg (ZEC/SOL into
  wNEAR) is 1Click on mainnet and was not run.
- **Epochs end (G2).** The stream ran on at `epoch_budget` forever and had
  paid 95.4 credits against 49 ever bought. `migrate_epochs` closed it at the
  migration block, settling everything earned to then; epochs now roll
  themselves back to back from the reserve, a full `epoch_target` or nothing.
  The reserve held 8.96 against a target of 40, so the stream is stopped
  (`epoch_unfunded`, short by 31.04) until the treasury buys credits or the
  target is lowered. `tests/migration.rs` read the live `STATE` first.
- **Shields weigh (G3).** +5% staking weight per shield, three at most,
  through a new `get_pet_stake_attrs` view — `PetAttrs` and every stored
  record are unchanged. `sync_pet(6)` resynced through it.
- **Stuck levels (G4).** `settle_levels(1, 50)` levelled pet 8 RINGER, which
  held 81 XP at level 0 from before the curve changed.
- **Sheets on chain (G5).** `contracts/art` stores sprite sheets by SHA-256;
  `/api/art/<hash>.png` serves them; `/create` uploads and registers.

Redeployed on 2026-11-12 to close a market hole, in
`ExrmsQcyeGvhuZRvoSHJkbDZhNNW4e9E3HtXQHPxgVYW` (transaction
`9mESVVUwk1EqRiH5Mc2suKyH7j1jaPcd6pNyTzL4gGyN`). Code only, `without-init-call`.
Previous: `Br4xYLaxJrerJqXCTBrDHuHccXcNjhvtMvhzz4ukUMhK`.

`nft_transfer` ended a pet's listing and `nft_transfer_call` did not, and
`buy_pet` never checked that the seller still owned the pet. So a pet listed,
then moved with `nft_transfer_call`, could still be bought: the buyer took it
from its new owner and the old owner was paid. `nft_transfer_call` now unlists,
and `buy_pet` refuses a listing whose seller is not the owner. No listing was
open when it shipped. Replayed on chain: pet 11 listed, moved with
`nft_transfer_call`, and the listing went with it (`pet_unlisted`,
"transferred").

Redeployed on 2026-11-12 for `retire_species`, in
`Br4xYLaxJrerJqXCTBrDHuHccXcNjhvtMvhzz4ukUMhK`. Code only, `without-init-call`.
Previous: `5ETVU2FreFeiPbKMXCs8bsGG8LHr4APb9ybL1cbg8an2`.

Then `retire_species("reference")` in
`67ngX5N4BcJiRystFtfzS1XKSdxWA1hdvBojQsqSg3cM` withdrew the Reference Atlas,
the worked example, and burned its two pets: #9 ATLAS (held by the mint
router) and #10 ROYAL (held by the game account, left from the royalty
check). Both were the project's own; the method refuses a species any player
holds a pet of. Its sheets and `tools/make-sheet.py` went with it.

Redeployed on 2026-11-11 for the 1% creator royalty, in
`5ETVU2FreFeiPbKMXCs8bsGG8LHr4APb9ybL1cbg8an2`. Code only — no stored struct
touched — so it went out `without-init-call` and kept its state: nine pets and
three species read back unchanged. Previous:
`HxuA1Z5hFLujj1dr4xiQmiS3p86HPLL7hNUu5HRj5aZp`.

Checked by watching the money rather than by trusting the tests. Minting one
`reference` pet for 2 NEAR
(`48ZqBcemr5xU25b1hPCDQRHSHJskqjevsrstYffWFZQ1`) moved the species creator's
balance from 3.8961 to 3.9161 NEAR — exactly 0.02 — and `revenue_banked` from
7.00 to 8.98, exactly 1.98. The two add back up to the deposit, which is the
property the unit test asserts and the only one worth confirming on chain.

Deployed on 2026-11-11, and the first deploy in this project that is a real
Borsh layout change on the game contract rather than a code-only swap. It adds
`species`, `species_price` and `revenue_banked` to the contract struct, so it
went out `with-init-call migrate` — `migrate-game-testnet.sh`, transaction
`5k2qJkkaPNbkbbRMigGC3ZtDDiPtqvkHMb9oYRSZaoG3`. The staking contract went out
`without-init-call` in `m49WpXcVvfkKxoFSw1M98KWCUapmg3aSdhkPPfpkWGq`, which is
code only. Previous pair: `Gcudy7AqgKHaFMKPwe3Vm69A4zbW8ZfeU6aHKLTVyXpF` and
`RbQJzW6NDKkPbbbmpZrNYAm7XCejUx12WQisXStLXxX`.

All eight pets read back with the same level, XP and evolution phase they had
before, the registry seeded its two species, and the staking pool was
untouched: two staked pets, weight 307, 48.96 credits in reserve.

`refresh_metadata` then rewrote all eight in
`EEsCiG7HEkR3sFyeqYPG9U7Lb4bBKQemBnggf6NnhAPo`. Every pet this game has ever
minted carried `media` as `/assets/animation/<category>/<phase>.gif`, a
relative path that resolves only inside the desktop app, so every wallet and
explorer drew them broken. They now carry absolute urls that return 200.

`revenue_banked` starts at zero rather than at the balance, on purpose: this
account holds mint revenue *and* the NEP-171 storage staking for eight tokens,
and nothing on chain can tell them apart after the fact. The ~22 NEAR sitting
there is swept, if at all, with the old `sweep`.

Nothing inside `pets` changed: `Pet` is untouched, so every stored record is
still read by the code that wrote it, and `category` carries over as the key
into the new registry.

`migrate` was checked against the deployed bytes before being run.
`contracts/game/tests/migration.rs` holds the live `STATE` key of
`jg-game-5656.testnet` as a fixture and deserialises it with the same
`OldGame` layout `migrate` uses — and asserts the slice is consumed whole,
because a layout that is a prefix of the real one parses happily and leaves
bytes over, which is exactly what a field added at the end looks like. A unit
test cannot do this: it builds the old struct with the same compiler that
reads it back, so it agrees with itself and says nothing about bytes a
different binary wrote months ago. That is how both previous losses passed
their tests.

The game contract was redeployed again to flatten the level curve (60 x 1.12
instead of 100 x 1.18) and to put an evolution two levels apart instead of
five. Pure arithmetic on values the contract already stored — `level` and
`xp` keep their meaning, and `grant_xp` levels in a loop, so a pet carrying
more XP than the new threshold catches up on its next award. Previous:
`9xBRKnnMavZCMgs8GxckwTxveh1AqBC1cyw9pNBG8hPz`.

## Why this file exists

The source used to live in two repositories, and nobody could say which one a
deployment came from. That is not a tidiness problem. Building `pet-stake`
from the wrong tree and deploying it took `jg-stake-5656.testnet` down with
`Cannot deserialize the contract state` — the struct had gained fields for
auto-feed in the other repository, so the new code could not read the state
the old code had written. Every staked pet and every credit balance was
unreachable until the exact previous binary went back on.

Nothing about that was obvious beforehand. Both trees built, both passed their
tests, and the method lists differed by four names that no test looked at.

The hashes above make it checkable in one command instead.

## The struct that does not look stored

`PetAttrs` is a view struct. It is also stored, inside every `StakedPet`:

```rust
pub struct StakedPet {
    pub pet_id: u64,
    pub owner_id: AccountId,
    pub weight: U128,
    pub attrs: PetAttrs,   // ← Borsh, in `pets: UnorderedMap<u64, StakedPet>`
    pub staked_at: U64,
}
```

Adding a field to `PetAttrs` therefore adds bytes in the *middle* of every
stored `StakedPet`, and `staked_at` after it no longer lands where the reader
looks. Every record written before the deploy becomes unreadable, and
`get_staked_pets` fails with `Cannot deserialize value with Borsh` — which
reads as a different fault from the state-level one above and is the same
mistake.

This happened. A `shield: u32` was added to `PetAttrs` so that carried
shields could count towards staking weight; the contract compiled, 143 tests
passed, every view that did not touch a staked record kept working, and the
panel broke for exactly the accounts that had a pet in the lab.

If you need per-pet data in the weight calculation, pass it alongside
`PetAttrs` rather than inside it, or write a migration that reads the old
layout explicitly. Do not add a field to anything reachable from a stored
struct and assume the tests will tell you.

## Checking before you deploy

Build the contract and compare:

```bash
cd contracts/pet-stake && cargo near build non-reproducible-wasm --no-abi
```

The last lines print `SHA-256 checksum bs58`. Against the chain:

```bash
near account view-account-summary jg-stake-5656.testnet network-config testnet now
```

If the hash you have does **not** match the table, your tree is not what is
deployed. Find out why before deploying, rather than after.

## If a deploy breaks the state

The previous code is still on an archival node, and it is exact — far better
than rebuilding from a guess at the right commit. Find the block before the
deploy and ask for the code at that height:

```bash
curl -s https://archival-rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
        "request_type":"view_code","block_id":<height>,
        "account_id":"jg-stake-5656.testnet"}}' \
  | python3 -c 'import json,sys,base64; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["result"]["code_base64"]))' \
  > recovered.wasm
```

Then deploy `recovered.wasm` with `without-init-call`. A deploy replaces code
and never touches state, so putting the old code back restores service
completely — the numbers come back exactly, `updated_at` included.

## Upgrading

A code-only change deploys `without-init-call` and keeps state. A change that
adds a field to the contract struct is a Borsh layout change and needs
`migrate` — see `migrate-testnet.sh` and `docs/GAME_CONTRACT_V2.md` §9, which
records the two deployments this project has already lost to one.
