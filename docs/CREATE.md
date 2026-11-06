# Letting people make pets

Notes from reading how petdex does it, and what changes when a pet is an NFT.

## What petdex actually does

Read from `crafter-station/petdex` source rather than from the marketing page.
`/create` is a landing page; the mechanism is the submit flow behind it.

`POST /api/cli/submit` is the whole shape in one handler:

- **Bearer auth** — `verifyCliBearer`, a Clerk identity. Anonymous submission
  is not a thing.
- **Two rate limits** — per IP before auth, then 20 presign requests per hour
  per user. Admins skip the second.
- **Three presigned R2 `PUT` URLs**, for `zip`, `sprite` (webp or png) and
  `petjson`, under a key built from a sanitised slug plus a random upload id.
- **A byte cap** returned to the client as `maxBytes`.

So the bytes never pass through their server. The client uploads straight to
storage and then calls `submit/register`; `submit/check` exists for a dedup
pass before any of that. Approval is separate — `api/admin` is a review
surface, and the public manifest only carries approved pets.

Four things worth taking whole: direct-to-storage uploads, a dedup check
before the upload rather than after, rate limits in front of the presign, and
a review step between submitting and appearing.

I could not read `register`, `check` or the admin routes — GitHub rate-limited
me partway. The outline above is from `submit/route.ts` and the repository
README, not from guessing.

## Where ours differs, and it is not a detail

A petdex pet is a row that becomes a folder. A JOYGOTCHI pet is an NFT, and
the thing a creator submits is not a pet at all — it is a **species** that
other people then mint. That is the whole design problem, and the contract
says so today:

```rust
const CATEGORIES: [&str; 2] = ["blackdragon", "greendragon"];
```

Two hardcoded dragons, checked on every mint. Nothing a creator uploads can
become mintable while that is a constant.

## Three ways to open it

### 1. A species registry on the game contract

`CATEGORIES` becomes stored state — an `UnorderedMap<String, Species>` — and
`create_pet` checks membership instead of a literal. A species carries its
slug, its art path, and who registered it.

Smallest change that makes submissions real. It is also a Borsh layout change
to `Game`, which this project has already had break testnet twice; it wants
the migration entry point `docs/GAME_CONTRACT_V2.md` §7 describes, not another
fresh deployment.

### 2. Creators earn from mints of their species

The registry entry gains a `creator` and a basis-point share, and
`internal_mint` splits the mint price the way `buy_pet` already splits a sale
price between seller and treasury. The marketplace fee logic is written and
tested; this is the same shape pointed at a different pair of accounts.

This is the version worth building, because it answers "why would anyone
submit a pet" with something better than attribution.

### 3. Pay to register

Registering a species costs NEAR, which pays for review and makes spam cost
something. It also pairs badly with (2) unless the share is good, so the two
numbers have to be set together rather than separately.

## Where the art lives

petdex presigns R2 and hosts the result. We could, and it is the least work,
but it puts the art for an NFT behind a bucket we pay for — a pet whose
picture disappears when a bill lapses is a bad NFT.

The alternatives are IPFS or Arweave, addressed by content hash, with the hash
on chain in the species entry. That removes us from the critical path of
somebody else's asset and makes the `media_hash` field in
`nft_token`'s metadata — which the contract already carries and currently
leaves `null` — mean something.

Worth noting the thing that makes this cheaper than it sounds: our pets are
one GIF per evolution phase, not a 9-row atlas. A species is three files.

## Review, and what it is for

Submissions need a gate, and not only for quality. petdex's own README says
pets are user-submitted fan art and carries a takedown template, which is the
honest version of the problem: anything that lets strangers publish art
attached to a name will be used to publish art somebody else owns.

On chain that gets worse, because a registered species cannot be quietly
deleted. So the registry needs a `paused` or `retired` flag per species from
the first version — a species that stops being mintable without pretending
the pets already minted from it never existed.

## What would have to be built

In order, each useful on its own:

1. `register_species` / `set_species_enabled` on the game contract, owner-only,
   with `create_pet` reading the registry. Plus the migration, because this
   changes a stored struct.
2. A submit page and an asset pipeline — content-addressed, so the hash goes
   in the registry entry.
3. A review surface. Admin-only, and the smallest thing that works is a list
   with approve and reject.
4. The creator share in `internal_mint`, reusing the split in `buy_pet`.
5. `PET_SPECIES` on the client stops being a constant and reads the registry —
   `packages/pet` already crosses-checks it against `CATEGORIES`, and that test
   is what will tell us when the two have drifted.
