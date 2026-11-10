# The feed oracle

`auto_feed` and `award_feed_xp` on the staking contract are gated to one
account, and until this existed nothing called either. The auto-feed switch in
the app was permission granted to nobody.

It does two jobs, because both need the same key.

On a timer it polls the contract for accounts that turned auto-feed on, works
out which of their pets are close to starving, and buys those meals out of the
budget each player set on chain.

On a loopback port it grades meals the app has just bought and pays their XP.
That half used to live in the web app, which meant a key that writes to the
contract had to sit on Vercel. It bought nothing: this process already holds a
key, already runs, and has to read the transaction anyway. So the split now
follows the secrets — the web service keeps the NEAR AI key and returns a
grade, this keeps the NEAR key and signs.

## What it can do, and what it cannot

The key it holds is a NEAR **function-call access key** for `auto_feed` and
`award_feed_xp` on the staking contract. That is the whole of its power:

- It cannot move NEAR. Function-call keys attach no deposit, ever.
- It cannot transfer, sell or evolve a pet.
- It cannot spend more of a player's credits than the daily budget that player
  set, because the contract checks the budget, not this process.
- It cannot feed somebody who never turned auto-feed on.
- It cannot pay XP for a meal nobody bought, or pay the same meal twice: the
  contract records each graded meal and refuses the repeat.
- It cannot mint XP without limit. The contract caps a single award, and the
  grade it is given is clamped before the call as well.

If this machine is taken, what goes with it is the ability to feed people's
pets on schedule and to pay out XP for meals they really bought. Give it a key
for those two methods and nothing else — a full-access key here would be a far
larger thing to lose than a service.

## Running it

```bash
ORACLE_ACCOUNT=feeder.jg-stake-5656.testnet pnpm --filter @joygotchi/oracle start
```

The secret is read from `~/.near-credentials/<network>/<account>.json`, where
`near account add-key … save-to-legacy-keychain` puts it. `ORACLE_KEY` still
works if you would rather pass it, but a key that has been through a shell is
in a history file, and there is no need to put it there.

### Leaving it running

It is only useful when it runs without being asked, so on macOS it installs
as a login agent:

```bash
./launchd/install.sh feeder.jg-stake-5656.testnet testnet
```

An agent rather than a daemon: the key lives in this user's
`~/.near-credentials`, so the process belongs to the user and not to the
machine. A daemon runs as root and would need the secret somewhere root can
read it, which is more to arrange for nothing gained.

It restarts if it dies, with a minute between attempts so a crash loop does
not spin. Logs land in `~/Library/Logs/joygotchi/`.

```bash
launchctl bootout   gui/$UID/dev.joygotchi.oracle   # stop
launchctl kickstart -k gui/$UID/dev.joygotchi.oracle # restart
```

Re-running `install.sh` updates it in place rather than leaving a second
copy, and it refuses to install at all when there is no key at the path the
process will read — otherwise the first sign of trouble is a process
restarting every minute and feeding nothing.

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
  --receiver-account-id jg-stake-5656.testnet \
  --method-names 'auto_feed,award_feed_xp' \
  autogenerate-new-keypair save-to-legacy-keychain \
  network-config testnet sign-with-keychain send
```

Both methods in one key, because a function-call key's method list is fixed
when it is granted and can never be widened. A key for `auto_feed` alone keeps
feeding and fails every grade with `does not allow method award_feed_xp`.

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

## Grading a meal

```
POST http://127.0.0.1:8787/grade   {"txHash": "...", "accountId": "..."}
```

Loopback and nothing else, with no token on it. This process holds a key, and
anything already running as this user could call the port — but anything
running as this user can read the key file too, so a token would be guarding
the smaller of the two doors. What a local caller can actually achieve is
bounded by the contract: a meal must have been bought with real credits to
exist at all, and it is paid once.

The hash is a pointer at the chain, not a claim. Which pet, whose account and
whether a Focus Lens burned all come from the transaction's receipts, read
here. Lying means producing a transaction, and producing one costs the credits
it is asking to be paid for.

The grade comes from the web service, which holds the NEAR AI key, and it is
trusted for the number alone. The lens multiplier is applied here, against the
receipt — if both sides applied it, a lens meal would pay four times.

A grader that will not answer scores the floor rather than nothing. The meal
was bought and paid for; a model having an off day is not the player's fault.

| Variable | Default | |
| --- | --- | --- |
| `ORACLE_PORT` | `8787` | the loopback port |
| `SITE` | `https://joygotchi.vercel.app` | asked for the grade |
