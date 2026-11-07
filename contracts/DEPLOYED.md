# What is actually deployed

The three testnet contracts, and the hash each one should build to from this
repository. Every entry here has been checked by building the source in this
tree and comparing with what the chain serves.

| Account | Code hash (bs58 of the SHA-256) |
| --- | --- |
| `jg-game-5656.testnet` | `Gj3biaYhUHuREJzw5SJoiW3mUfgAAcy22KLjgnsfzhQ2` |
| `jg-stake-5656.testnet` | `CxTuabNuBd86GHzGLBcf9hKaHPYGkez7tRSbfrq41wLg` |
| `jg-mint-5656.testnet` | `8J2feEm9mKq5oMhm3Bhw25iWCwWHHbdn8DipbsR85vM9` |

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
