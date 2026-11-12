# Going to mainnet

Multichain minting runs through 1Click, and 1Click settles on **NEAR mainnet
only**. Every contract this game uses is on testnet today, so a player paying
in ETH, SOL, BTC or TRON has nowhere to land. This is the checklist for
putting the game on mainnet. Nothing here has been run.

## Accounts

The pay app (`joygotchi-near-client-bot`) is already configured for these
names, and the web app derives the art contract from the game's name
(`art.<game>`), so they are the ones to create:

| Account | Holds | Code size | Code storage |
|---|---|---|---|
| `game-v2.joyv1.near` | the game: pets, species, market | 378 KB | 3.78 NEAR |
| `stake.joyv1.near` | the credit ledger and AI Lab | 327 KB | 3.27 NEAR |
| `mint.joyv1.near` | the mint router 1Click pays | 197 KB | 1.97 NEAR |
| `art.game-v2.joyv1.near` | sprite sheets on chain | 141 KB | 1.41 NEAR |

Storage is 10¹⁹ yoctoNEAR (0.00001 NEAR) a byte, read from
`EXPERIMENTAL_protocol_config` on mainnet. Code alone is **10.4 NEAR**; state
grows with pets and is paid by the contract's balance.

`joyv1.near` exists and holds 1.56 NEAR. Fund it with about **16 NEAR** before
starting:

| For | NEAR |
|---|---|
| `game-v2` (code + first ~200 pets of state) | 5.0 |
| `stake` (code + accounts) | 4.5 |
| `mint` (code + wNEAR storage) | 2.5 |
| `art.game-v2` (code; sheets are paid by uploaders) | 2.0 |
| gas and margin | 2.0 |

## Decisions to make first

These are numbers testnet never had to get right.

1. **Mint price.** 2 NEAR on testnet (about $7). 1Click's quote adds a few
   cents; a $100 minimum on TRON is in force as of 2026-11-12, so TRON
   payments will be refused at today's price.
2. **Species price.** 5 NEAR on testnet. It is the only thing stopping
   name-squatting, and the creator earns 1% of every mint.
3. **Owner keys.** On testnet each contract owns itself with a key in the
   macOS keychain. On mainnet the owner can retire species, pause the game
   and move the treasury: use a Ledger, or a multisig, not a laptop key.
4. **Treasury.** Mint revenue and market fees go here. On testnet it is the
   router. Pick an account that buys NEAR AI credits.
5. **Credit stream.** `epoch_target` per 30 days and a first `fund_reserve`.
   The reserve must hold credits actually bought on NEAR AI — see
   `contracts/DEPLOYED.md` on why the testnet stream had to be cut.
6. **1Click key.** The distribution-channel key already in the pay app's
   `ONECLICK_JWT` is a mainnet key; nothing to change.

## Steps

Build first — `./build.sh` writes the wasm the hashes are recorded against.

```bash
cd contracts && ./build.sh
```

Create the accounts (each signed by `joyv1.near`):

```bash
near account create-account fund-myself game-v2.joyv1.near '5 NEAR' autogenerate-new-keypair save-to-keychain sign-as joyv1.near network-config mainnet sign-with-keychain send
near account create-account fund-myself stake.joyv1.near '4.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as joyv1.near network-config mainnet sign-with-keychain send
near account create-account fund-myself mint.joyv1.near '2.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as joyv1.near network-config mainnet sign-with-keychain send
near account create-account fund-myself art.game-v2.joyv1.near '2 NEAR' autogenerate-new-keypair save-to-keychain sign-as game-v2.joyv1.near network-config mainnet sign-with-keychain send
```

Deploy with the same `new` arguments `deploy-testnet.sh` uses, with
`wrap.near` for wNEAR and the decisions above for prices and treasury. Then
wire: register the router on `wrap.near` (`storage_deposit`), fund the
reserve, set `epoch_target`.

## Switching the apps

| App | Change |
|---|---|
| web (`apps/web`) | `PUBLIC_NEAR_NETWORK=mainnet`, `PUBLIC_GAME_CONTRACT=game-v2.joyv1.near`, `PUBLIC_STAKE_CONTRACT=stake.joyv1.near`, mint price |
| pay app (`joygotchi-near-client-bot`) | already points at these names |
| desktop | default network and contracts in its settings |
| CLI | default network and contract in `packages/cli/src/chain.ts` |
| oracle | `NETWORK=mainnet`, contract names, a new function-call key |

## Check before announcing

- `get_config` on each contract reads back the wiring.
- A NEAR mint from the web: pet appears, `revenue_banked` rises by the price.
- A 1Click mint from another chain, small: the router's `mint_paid` and
  `pet_minted` events, and the creator's `royalty_paid` on a player species.
- Record every code hash in `contracts/DEPLOYED.md`, as for testnet.
