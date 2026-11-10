# The feed oracle

`auto_feed` and `award_feed_xp` on the staking contract are gated to one
account, and until this existed nothing called either. The auto-feed switch in
the app was permission granted to nobody.

This process polls the contract for accounts that turned auto-feed on, works
out which of their pets are close to starving, and buys those meals out of the
budget each player set on chain.

## What it can do, and what it cannot

The key it holds is a NEAR **function-call access key** for `auto_feed` on the
staking contract. That is the whole of its power:

- It cannot move NEAR. Function-call keys attach no deposit, ever.
- It cannot transfer, sell or evolve a pet.
- It cannot spend more of a player's credits than the daily budget that player
  set, because the contract checks the budget, not this process.
- It cannot feed somebody who never turned auto-feed on.

If this machine is taken, what goes with it is the ability to feed people's
pets on schedule. Give it a key that can do only `auto_feed`, and nothing else
— a full-access key here would be a far larger thing to lose than a service.

## Running it

```bash
ORACLE_ACCOUNT=feeder.jg-stake-5656.testnet pnpm --filter @joygotchi/oracle start
```

The secret is read from `~/.near-credentials/<network>/<account>.json`, where
`near account add-key … save-to-legacy-keychain` puts it. `ORACLE_KEY` still
works if you would rather pass it, but a key that has been through a shell is
in a history file, and there is no need to put it there.

A dry run needs no key at all and prints what it would buy:

```bash
DRY_RUN=1 pnpm --filter @joygotchi/oracle start
```

| Variable | Default | |
| --- | --- | --- |
| `ORACLE_ACCOUNT` | — | required unless `DRY_RUN=1` |
| `ORACLE_KEY` | — | optional; the credentials file is read when it is unset |
| `ORACLE_KEY_FILE` | `~/.near-credentials/<network>/<account>.json` | |
| `NETWORK` | `testnet` | |
| `STAKE_CONTRACT` | `jg-stake-5656.testnet` | |
| `GAME_CONTRACT` | `jg-game-5656.testnet` | |
| `POLL_SECONDS` | `300` | |
| `DRY_RUN` | — | `1` to decide and print, signing nothing |

## Granting the key

From the oracle account's own wallet, add a function-call key limited to one
method:

```bash
near account add-key feeder.jg-stake-5656.testnet \
  grant-function-call-access --allowance '1 NEAR' \
  --contract-account-id jg-stake-5656.testnet --function-names 'auto_feed' \
  autogenerate-new-keypair save-to-legacy-keychain \
  network-config testnet sign-with-keychain send
```

`save-to-legacy-keychain` rather than `print-to-terminal`: the secret goes
straight to the file this process reads and is never displayed.

The staking contract must also name that account as its oracle
(`set_oracle`), which is a separate decision made by the contract's owner.

## When it decides to feed

In `decide.ts`, away from the network so it can be tested without one. A pet
is fed when it has less than one meal's worth of food left — twelve hours.

Earlier is not kinder: the game contract caps banked food at seven days and
discards the rest, so a meal given to a well-fed pet is mostly spent on
nothing. Later is the real risk, and twelve hours leaves a full meal of margin
before the deadline, so one missed poll does not kill a pet.

A pet that has already starved is skipped. `feed_from_stake` refuses it —
coming back takes a revival item paid in NEAR, and that is the owner's
decision, not one to make on their behalf.

Where a budget cannot cover every hungry pet, the hungriest eat first. If it
has to run out, it should run out on the pets with the most time left.

## Not yet: feed XP

`award_feed_xp` is the other half, and it needs to know a meal happened. That
means reading `pet_fed` events, which means an indexer or a verified
transaction hash from the app — neither is here. A fed pet still earns no XP.
