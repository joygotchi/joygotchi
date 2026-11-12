# JOYGOTCHI economy

## The one idea

Most tamagotchi-with-a-token games mint their premium currency out of nothing,
then spend the rest of their life defending the price. JOYGOTCHI does not have a
premium token. It has **AI credit**, and one credit is one US dollar of real
NEAR AI Cloud compute.

That changes the shape of the whole economy:

```
   NEAR wallet        BTC / ETH / SOL / TRON / TON / … (17 chains, mainnet)
        │                    │
        │                    │  NEAR Intents · 1Click → wNEAR → mint-router
        ▼                    ▼
      game contract  ── 1% of each mint ──▶  the species' creator
        │
        │  mints, species, NEAR shop, 2.5% market fee
        ▼
     treasury  ── buys NEAR AI credits ──▶  fund_reserve
                                                │
                                   sale_reserve (credits that exist)
                                                │
                              one full epoch_target, every 30 days
                                                ▼
   a pet ── stake in the AI Lab ──▶  pet-stake  (streamed by weight, every second)
                                                │
                                                ▼
                                            AI credit
                                                │
                       spent on feeds, revives, training, items, chat
                                                ▼
                         NEAR AI inference  (the credit is consumed for real)
```

Emission is bounded by something that exists outside the game: credits the
treasury has actually bought on NEAR AI and recorded in the reserve. An epoch
only starts when the reserve holds all of it, so we cannot print more credit
than we can pay for, and every credit a player spends is compute we genuinely
buy. There is no float to defend, because credits are
never tradeable.

## The two resources

There is **no game token**. There is NEAR, and there are credits.

| | **NEAR** | **AI credit (ACR)** |
|---|---|---|
| What it is | the chain's own token | account balance in `pet-stake`, 6 decimals |
| Transferable | yes, it's NEAR | **no, on purpose** |
| How you get it | you hold it, sell a pet, earn creator royalties — or, on mainnet, 1Click swaps your BTC/ETH/SOL/… into it | staking pets, mining, battle wins, selling items, the faucet, or buying at a bad rate |
| What it buys | pets, species, NEAR shop items, hats, other players' pets, credits | feeds, revives, training, evolving, credit items, chat |
| Peg | the market's | 1 ACR = US$1 of NEAR AI compute |
| Role | the way in | the only thing you earn and spend |

An earlier design had a third resource, a mintable soft currency called $JOY.
It is gone, and removing it forced a useful question: **a soft currency is what
lets a game reward play cheaply.** Without one, every reward is either real
money out of the treasury, or it is credits.

Rewards are credits. That caps them against the treasury's NEAR AI allowance —
a real constraint — rather than against a number somebody picked. NEAR does one
job and only one: it is how value enters.

Worth knowing: `$JOY` never existed on-chain anyway. `faucet.joyv1.near` is not
a NEP-141, exposes no balance view at all, and the "1 JOY" prices in the old
client were labels with nothing behind them.

## How credit accrues

Stake a pet in the **AI Lab** (`pet-stake`) and it starts working. While staked:

- it **cannot be sold, transferred or approved** — a sale has to be atomic,
  and a staked pet's record lives in another contract,
- it **still starves**, so you still have to feed it,
- it **can still fight**, and a fight that changes its level or star
  re-weights it straight away (`sync_weight`),
- it earns a share of the stream proportional to its weight.

```
weight = base(rarity) × (1 + level/20) × (1 + star × 0.15) × evolution × (1 + 5% × shields)

base:        common 100 · rare 160 · epic 260 · legendary 400
evolution:   phase 1 ×1.00 · phase 2 ×1.15 · phase 3 ×1.35 · phase 4 ×1.60
shields:     NEAR-shop Shields the pet holds, counted up to 3
```

Rarity is rolled by the game contract at mint (70% common, 20% rare, 8% epic,
2% legendary) and read by `pet-stake` through `get_pet_stake_attrs`, which
returns owner, attributes and shield count in one call.

A brand-new common pet is weight 100. A fully maxed legendary (level 20, 5
stars, phase 4) is weight 2,240 — about 22 commons, not 22,000. Growth is
sub-linear on purpose: one whale must not be able to flatten the stream for a
hundred casual players, or the AI Lab stops being worth opening.

Your rate is then:

```
credits_per_second = (epoch_budget / 30 days) × (your_weight / total_weight)
```

### Epochs: the stream only pays what exists

The stream runs one 30-day **epoch** at a time, and an epoch is funded in full
or not at all:

1. The treasury buys credits on NEAR AI, then records them with
   `fund_reserve`. That is the only step off chain.
2. When an epoch ends, the next settle of the pool — any claim, stake or
   auto-feed — moves exactly `epoch_target` from `sale_reserve` into the
   stream and starts the next epoch back to back. `roll_epoch()` does the
   same, for anyone, when nobody has touched the pool.
3. If the reserve is short, emission stops at the epoch's end and the contract
   logs `epoch_unfunded` with `short_by` — the number the treasury has to buy.

`get_pool` publishes `epoch_target`, `epoch_ends_at` and `sale_reserve`, and the
oracle's treasury watch (`apps/oracle/src/treasury.ts`) alerts when the next
epoch is not covered.

This replaced an open-ended `epoch_budget` that kept streaming whether or not
anything stood behind it. On testnet it had paid out 95.9 credits against 49
ever bought before it was cut; `migrate_epochs` moved the live contract to the
new state. Testnet today: target **8 credits / 30 days**, current epoch ending
2026-12-11, reserve 0.96 — so about 7 more credits must be bought and funded
before then, or the stream pauses.

This is the standard accumulator pattern — the same `reward_debt` shape the
existing pet contract already uses, so it should read as familiar. The accrual
is continuous, which matters for feel: the number in the header ticks up while
you look at it, and claiming is one transaction that batches whatever has piled
up.

### A worked example

Say the treasury buys **$500/month** of NEAR AI credits, so
`epoch_target = 500_000_000` micro-credits. A meal is 0.015 credit and buys 12
hours, so a pet needs two a day — 0.03 credit — never to go hungry.

| Pool | Your pets | Your weight | Pool weight | Your credits/day | Meals that pays for |
|---|---|---|---|---|---|
| early | 1 common | 100 | 5,000 | 0.33 | 22 (11 pet-days) |
| growing | 1 common | 100 | 50,000 | 0.033 | 2 — just keeps it fed |
| growing | 3 pets, lvl 10 | 900 | 50,000 | 0.30 | 20 (10 pet-days) |
| mature | 3 pets, lvl 10 | 900 | 400,000 | 0.037 | 2 — one pet of the three |

Note what happens as the game grows: a single unupgraded pet drifts toward
"just pays for its own food", while an invested player stays above water. That
is the intended pressure — it pushes levelling, evolving and shields, which are
themselves sinks.

And when the pool grows, revenue grows with it: more players means more mints,
species and market fees, means more NEAR to buy compute with, means a larger
`epoch_target`. The treasury raises it with `set_epoch_target`, and it takes
effect at the next epoch — when the reserve can cover it.

## What credits buy

| Action | Cost | Method | Effect |
|---|---|---|---|
| **Feed** | 0.015 ACR | `feed_pet` | 12 hours on the hunger clock; the AI grades the meal and sets its XP (taste match ×1.0–1.8, capped at 72 XP) |
| **Revive** | 0.075 ACR | `revive_pet` | Brings a starved pet back with 12 hours on the clock |
| **Train** | 0.008 ACR | `spend_credits` | A generated sparring drill raises ATK or DEF |
| **Craft item** | 0.02 ACR | `spend_credits` | An item rolled from your pet's own history |
| **Talk to pet** | 0.001 ACR | `spend_credits` | One message, answered in the pet's voice |
| **Evolve** | 0.50 ACR | `evolve_pet` | Next evolution phase — permanently more weight and a better drop rate |
| **Auto-feed** | 0.015 ACR | `auto_feed` (oracle) | The oracle feeds your pet from a daily budget you set, while you are away |

Feed, revive and evolve go through their own methods, which call the game
contract and give the credits back if it says no (a pet that is not yours, or
not dead). `spend_credits` refuses those three outright: it would take the
credits and move no clock.

Every row has something on chain that carries it out. That is the rule the
table is kept to, and it is a rule because it was broken: Revive once sat here
at 1.00 ACR with a seeded price and no contract behind it. It is back at 0.075
— five meals, the ratio Holy Water (0.5 NEAR) has against Beef (0.1 NEAR) — now
that `revive_pet` exists. Holy Water still works for anyone paying in NEAR.

Retiring a sink means `remove_action_price`, not a price of zero: zero passes
every check in `spend_credits`, so the action stays live and merely becomes
free.

### On the price of a feed

A ~200-token completion costs on the order of **$0.0004**, so a feed is not
priced at its inference cost. An earlier draft had a 0.002 ACR "AI feed" that
only rolled XP; the feed that shipped is a real meal — it moves the hunger
clock exactly like the oracle's auto-feed — so it costs what auto-feed costs.

The sum that matters is per pet-day: two meals, **0.03 ACR**. A $500/month
target keeps about 550 pets fed before anyone levels or evolves, which is why
the worked example above leans on weight: a pet that earns less than 0.03 a day
is one its owner tops up with mining, battle wins or items.

The feed is still the centrepiece. The pet has a taste profile, you do not know
exactly what it wants today, and a good match is worth nearly twice the XP of a
bad one. The oracle grades the meal on NEAR AI and awards the XP with
`award_feed_xp`, capped at `MAX_FEED_XP` so a compromised backend cannot level
a pet in a few calls.

## Items

Two shops, one per currency.

The game contract's shop is paid in **NEAR**, and the NEAR goes to the treasury:

| id | Item | Cost | Effect |
|---|---|---|---|
| 1 | Beef | 0.10 NEAR | time on the hunger clock, and XP |
| 2 | Water | 0.05 NEAR | a little time on the clock |
| 3 | Shield | 0.20 NEAR | absorbs one lost fight before a star does, and +5% staking weight while held, up to 3 |
| 4 | Holy Water | 0.50 NEAR | revives a starved pet |

A Shield is the one item that touches staking weight, and it can safely because
it changes only when the game contract changes it — on purchase, and when a
fight uses it up — and both paths call `sync_weight` there and then.

The credit shop lives in `pet-stake`:

| id | Item | Cost | Effect |
|---|---|---|---|
| 101 | AI Tonic | 0.01 ACR | clears a wound immediately |
| 102 | Sentinel Ward | 0.05 ACR | un-attackable for 24h; stacks rather than resetting |
| 103 | Focus Lens | 0.02 ACR | +0.25 XP multiplier on the next 10 AI feeds |
| 104 | Star Charm | 0.015 ACR | keeps your star if you lose the next battle |

Every effect here is pet *state* with a deadline or a counter. **None of them
touch staking weight.** That is deliberate: a weight that changed on a deadline
would need the pool updated at a moment when nothing is calling it.

Hats are a third kind of thing: NFTs of their own on the accessory contract,
bought in NEAR, worn on any pet and tradeable on any NEAR NFT market. They are
cosmetic and change no number in this document.

The Focus Lens is consumed by the contract inside `spend_credits`, and whether it
applied goes into the `credit_spent` event. The backend reads that event from the
transaction logs, so the bonus cannot be claimed by a client that merely says it
has one.

## After a battle: nothing dies

Pets do not die from fighting. Three reasons, in order of weight.

**1. Death plus a share-based stream pays people to grief.** Credits are
distributed by `your_weight / total_weight`. Killing another staker's pet lowers
`total_weight`, which **raises the killer's own income**. That is not a side
effect, it is a computable profit. Death and this stream must not ship together.

**2. The defender is offline and did not choose.** The attacker picks the
target. Dying of neglect is your own doing; losing a fight you started is a risk
you took; having a stranger destroy a pet you paid for while you sleep is
neither. That third case is the one that makes people uninstall.

**3. Death's economic job is already done.** Supply sinks exist to keep mint
demand alive, but pool dilution does that already: as `total_weight` grows your
share shrinks, so you always want more or better pets. No need to destroy what
players bought.

So losing a battle costs this instead:

| | |
|---|---|
| Wager | 0.01 ACR, moved from loser to winner |
| Rake | 5% of the pot → `sale_reserve`, never out of `epoch_budget` |
| Wound | 6 hours in which it cannot be attacked; an AI Tonic clears it at once |
| Star | lost, unless a Shield (used up) or a Star Charm absorbs it |
| Hunger | 3 hours off the clock, never past now — a fight cannot starve a pet |
| Streak | reset, so progress towards the next star goes too |

The winner takes 25 XP, a win on their streak, the pot less rake, and a roll
for an item drop.

Who wins is mostly arithmetic: effective attack is base × (1 + 5%·level) ×
(1 + 10%·star), defence the same with 4% a level; each side rolls within ±15%
from the block seed, and a tie goes to the attacker. A pet rests an hour after
attacking, and cannot be attacked again for an hour after being attacked.

The wager is a **transfer, not a destruction**: the loser's loss is the winner's
gain, so PvP is zero-sum between players rather than eating into the asset base
the treasury has to back with real compute. Rake funds the reserve behind credit
sales, mining and the faucet, so PvP never dilutes stakers.

A loser who cannot cover the wager still loses the fight — the pot is simply
whatever they had. Battles never fail for being poor.

### Stars: the PvP ladder

Stars are the one reward battling gives that staking cannot.

```
3 consecutive wins → +1 star (capped at 5)
1 defeat           → −1 star, and the streak resets to zero
```

Each star is **+15% staking weight** and **+10% on both ATK and DEF**, so
winning fights feeds the credit stream and makes the next fight easier. A Star
Charm (0.015 ACR) saves one on a single defeat, and a Shield absorbs the hit
before the star does.

This is what makes battling worth the opportunity cost. A staked pet earns
steadily and risks nothing; a battling pet earns a 0.01 ACR wager and a shot at
a compounding weight bonus, against six hours wounded and a star.

Stars were inert until this landed: a pet was minted at zero, nothing ever
raised it, and the three tests covering star loss each set `star = 2` by hand —
which is why they passed and why nobody noticed. The Star Charm protected
something that could not exist.

### Staked pets fight

The first design kept staked pets out of battle in both directions:
`is_attackable` said no for a staked pet, and the game contract refused to let
one attack, so that staking would not mark you as a target. In practice it made
battle impossible rather than restricted: staking is the only way to earn
credits, so every pet worth fighting was staked, and of eight pets on testnet
exactly one was both alive and unstaked.

Now `is_attackable` says no only for a ward or a wound. The game contract calls
`report_battle` first and applies damage in the callback, so a protected pet is
never hurt by a settlement that reverts. Staking still locks transfers, sales
and approvals — fighting moves no ownership, so that reason never reached it.

The grief incentive is smaller than it was, but not zero: a loss can cost a
star, a star is 15% of that pet's weight, and that nudges everyone else's share
up. What bounds it is the pacing — an hour between attacks, an hour's immunity
after being hit, six hours wounded after a loss, a Ward for anyone who wants a
quiet day — and that a defender with a better build simply wins.

## Keeping it smooth

The failure mode of every pet game is the player who comes back to a dead pet
and never opens the app again. Four things guard against it:

1. **Credits never hard-stop you.** Items drop while you play, other players
   sell them, mining pays every six hours, and the faucet covers your first
   few feeds.
2. **Auto-feed.** Set a daily budget with `set_auto_feed_budget` and the
   oracle feeds pets that are about to starve — 0.015 credit for 12 hours
   each — from your balance while you sleep. Capped by you per 24 hours, off
   by default.
3. **A one-off faucet.** `claim_faucet` grants 0.01 credit, once per account,
   from the treasury's sale reserve — five AI feeds, enough to see the good part
   before you own anything.

   It used to be 0.05 a day, which was a hole rather than a gift: NEAR implicit
   accounts are nearly free to create, so a script with a thousand accounts
   would have drawn $1,500/month against a $500 budget. One grant per account
   caps the damage at a finite amount instead of a rate.
4. **Accrual is visible.** The header ticks. You can watch the thing you earn.

## NEAR → credit

One way only: **0.5 NEAR per credit**, and never back.

A credit is a dollar of compute and NEAR trades around $4, so that is roughly a
2x markup. Deliberately: buying credits should be worse than earning them. It
exists as a safety valve for a player who wants to evolve a pet *today*.

Sales come out of a separate `sale_reserve` that the treasury tops up with
`fund_reserve` only after it has actually bought those credits on NEAR AI. When
the reserve cannot cover a purchase, the payment is **refunded** rather than
issuing credit that nothing stands behind.

Credits do not convert back, and cannot be transferred account to account —
only items can. This is the single most important constraint in the design: the
moment credits become tradeable they are a second speculative asset with an
implicit redemption promise, and the treasury carries a float it never agreed
to.

### The ledger never holds money

`pet-stake` is a pure ledger. It has no payable method, accepts no token, and
never holds NEAR. Credit purchases land on `mint-router`, which then calls
`grant_credits`.

NEAR spent *in the game* — mints, species, the NEAR shop, the pet market fee —
lands on the game contract, which counts it in `revenue_banked` and hands it to
the treasury with `sweep_revenue`. The only NEAR the game contract passes on to
anyone else is a seller's proceeds and a creator's royalty, both in the same
call that took it.

## Drops, and selling what you find

Doing things with your pet turns things up. Every AI feed, training session,
craft, mining claim and battle win rolls for an item drop.

```
chance = min(25%, 2% + staking_weight basis points)
```

A fresh common pet is weight 100 → **3%**. A maxed legendary is weight 2,240 →
**24.4%**. Weight also gates *what* can drop, so the best items only appear for
pets that earned them.

| Weight | Can find |
|---|---|
| 1–199 | AI Tonic |
| 200–599 | + Star Charm |
| 600–1,399 | + Focus Lens |
| 1,400+ | + Sentinel Ward |

The first version of this curve used `weight / 20`, which squeezed the whole
range between 2.05% and 3.1% and made the 25% ceiling unreachable. "Stronger
pets find more" was true only on paper; a unit test caught it.

### The market is between players

Items are listed for credits and bought by other players, with a 5% rake that
leaves circulation into the reserve.

Items are never sold **back to the contract**. Drops are free and the drop rate
rises with pet strength, so selling loot to the contract would be an inflation
pump with a difficulty slider on it. Between players, credits only change hands,
and the rake makes the market a small net sink.

Randomness comes from the block's random seed. Good enough for loot; a validator
could in principle influence it, so nothing of real value should ever hang on a
single roll.

## Selling a pet

Pets sell for **NEAR**, not credits. Credits are what you earn by playing and
are deliberately not transferable; a pet is an asset bought with money, so it
has a resale price.

That matters beyond convenience. Without it, minting is a one-way purchase and
nobody can recover any value, which caps what a pet is worth to a buyer at
"entertainment value" rather than "asset value" — and since mint revenue is what
funds `epoch_budget`, that cap propagates straight into the credit stream.

A 2.5% fee goes to the treasury, which is what gets staked with NEAR AI, so
trading volume feeds the credit stream too.

The last five sales of every pet are kept on chain (`get_pet_sales`, newest
first), so a buyer sees a price history rather than a guess. A listing is tied
to the owner who made it: if the pet has changed hands since, `buy_pet` refuses
it as stale rather than selling someone else's pet.

Listings live in the game contract rather than a separate marketplace. It
already owns transfers and the staking lock, so a sale is one atomic call: there
is no window in which a pet gets staked between being listed and being bought,
and no escrow hop to go wrong. Staking a listed pet, or transferring it out of
band (`nft_transfer`, `nft_transfer_call`), removes the listing — a buyer should never be sold a pet they cannot move.

## Mining

Mining pays **0.005 credit every 6 hours** and requires a pet staked in the AI
Lab.

The gate is the point. A NEAR account is nearly free to create, so anything
payable to "an account" is a sybil tap — which is exactly what the old
0.05-a-day faucet was. A pet costs 2 NEAR, so gating on staked weight prices
the attack.

## Creators: species and royalties

Anyone can add a **species** — the drawing every pet of it wears — with
`create_species`, for **5 NEAR** once. That price is the only thing stopping
names being squatted. The creator then earns **1% of every mint** of their
species (`CREATOR_ROYALTY_BPS = 100`), paid in NEAR in the mint's own
transaction: no claim step, no escrow.

The royalty takes the same path however the buyer paid. A NEAR mint and a
router mint both go through `paid_mint`; the router unwraps its wNEAR
(`near_withdraw`) and attaches the mint price to `create_pet_for`, so a
creator is paid whether the buyer came from a NEAR wallet or another chain.

A species' art is either a recolour recipe of a shipped dragon, or an 8×9
sprite sheet per evolution phase stored on chain in the art contract
(`art.<game>`), addressed by its sha256. The uploader pays the storage —
about 1 NEAR per 100 KB, refunded above cost — so the treasury carries none of
it and the picture cannot disappear when a bill lapses. The owner can
`retire_species` (no new mints; existing pets keep their art), which is the
answer to someone registering art that is not theirs.

## Multichain money-in

**Mainnet only.** 1Click settles on NEAR mainnet, and the contracts are on
testnet, so a testnet mint is paid in NEAR. The pay flow is built and waits on
the mainnet deploy in [MAINNET.md](MAINNET.md).

The player picks a chain, then an asset on it: **28 assets on 17 chains** —
BTC, ETH and USDC/USDT on Ethereum, Base, Arbitrum, Optimism, BNB Chain,
Polygon and Avalanche, SOL and Solana stablecoins, TRX and USDT on Tron, TON
and USDT on TON, ZEC, DOGE, LTC, XRP, SUI and APT. The app asks our server for
a 1Click quote (`EXACT_OUTPUT`, so the price is fixed in wNEAR and any excess
is refunded), shows a deposit address and a QR, and polls until the swap
settles. The refund address is checked against the chain's address format
before any quote, because a refund to a mistyped address is money nobody gets
back.

1Click withdraws the wNEAR to `mint-router` with `ft_transfer_call`, carrying
the `customRecipientMsg` our server attached to the quote. The router validates
the payment, unwraps it, and pays the game contract for the mint.

The server builds the entire quote: the client sends only *which asset* and
*which refund address*. Recipient, amount and message come from server config,
so a tampered request cannot redirect funds or mint a pet for free. The 1Click
key never reaches the browser.

Aurora's swap API was evaluated as a replacement and rejected: it drops
`customRecipientMsg`, which is how the router knows whose pet to mint.

Two details worth knowing:

- **Overpayment is change, not a donation.** The router returns the excess and
  1Click forwards it to the player's refund address on the origin chain.
- **A mint that fails is not a mint that is lost.** If the game contract rejects
  the call (paused, out of gas, mid-upgrade), the paid claim stays in
  `get_pending` and anyone can retry it with `redeem_pending`.

## Why the AI key is safe

The NEAR AI key sits on the server, and the endpoint that uses it is public. The
metering is therefore on-chain, in two steps:

1. The browser sends `spend_credits` to `pet-stake`. The contract charges **its
   own configured price**, not whatever the client asked for, debits the
   balance, and emits `credit_spent`.
2. The browser hands `/api/ai/chat` that transaction hash. The server looks the
   transaction up on the RPC and checks it succeeded, was signed by the account
   asking, went to our staking contract, called `spend_credits`, carried the
   action about to be performed, and **has not been presented before**.

No valid, unused receipt, no inference. The replay guard is in memory, which is
enough for one instance and for local development — point it at Redis or Vercel
KV before production, or two concurrent requests can share one receipt.

## Parameters, and where they live

Every number above exists in two places, which must be kept in step:

- [`packages/pet/src/economy.ts`](../packages/pet/src/economy.ts) — what the
  web and desktop apps show and project.
- The contracts — what is actually enforced. `pet-stake` seeds prices in
  `new()` and changes them with `set_action_price` / `set_item_price`; the game
  contract seeds its shop and fees the same way.

The contract is the authority. The client numbers are for display and for
telling the player what something will cost before they sign.

| Parameter | Value (testnet) | Set by |
|---|---|---|
| `epoch_target` | 8 ACR / 30 days | treasury, `pet-stake::set_epoch_target` |
| epoch funding | full target from `sale_reserve`, or nothing | `roll_epoch` / any pool settle |
| `near_per_credit` | 0.5 NEAR | treasury, `mint-router::set_near_per_credit` |
| feed / auto-feed | 0.015 ACR, 12 hours | `set_action_price`; hours fixed in `AUTO_FEED_SECONDS` |
| revive | 0.075 ACR | `set_action_price` |
| mining | 0.005 ACR / 6h, staked pet required | treasury, `set_mining_reward` |
| `faucet_amount` | 0.01 ACR, once per account | treasury, `set_faucet_amount` |
| drop curve | 2%–25%, +1bp per weight | fixed in `drop_odds` |
| item market rake | 500 bps (5%, capped at 20%) | treasury, `set_market_rake_bps` |
| `battle_wager` | 0.01 ACR | treasury, `set_battle_params` |
| `battle_rake_bps` | 500 (5%, capped at 20%) | treasury, `set_battle_params` |
| ward / wound | 24h / 6h | fixed in `pet-stake` `types.rs` |
| attack cooldowns | 1h after attacking, 1h after being attacked | fixed in game `types.rs` |
| loss hunger penalty | 3h | fixed in `attack` callback |
| wins per star | 3, capped at 5 stars | fixed in `WINS_PER_STAR` / `MAX_STAR` |
| shield weight | +5% each, up to 3 | fixed in `SHIELD_WEIGHT_BPS` / `MAX_WEIGHTED_SHIELDS` |
| mint price | 2 NEAR | game and `mint-router::set_mint_price` |
| species price | 5 NEAR | game owner |
| creator royalty | 100 bps (1%) of each mint | fixed in `CREATOR_ROYALTY_BPS` |
| pet market fee | 250 bps (2.5%, capped at 10%) | treasury, `game::set_market_fee_bps` |
| sale history | last 5 per pet | fixed in `SALES_KEPT` |
| NEAR shop | Beef 0.1 · Water 0.05 · Shield 0.2 · Holy Water 0.5 NEAR | game owner |
| art storage | paid by the uploader, ≤ 600 KB a sheet | art contract |
| credit decimals | 6 | fixed |
| rarity weights | 100 / 160 / 260 / 400 | fixed in `Rarity::base_weight` |
| rarity odds | 70 / 20 / 8 / 2 % | fixed in `Rarity::ODDS_BPS` |

## Open issues

Written down because they are real, not because they are solved:

- **The testnet stream runs out on 2026-12-11.** The reserve holds 0.96
  credits against an 8-credit target. Unless about 7 credits are bought on NEAR
  AI and recorded with `fund_reserve` before then, the next epoch does not
  start and staked pets stop earning until it does.
- **Credit accounting is trust-minimised, not trustless.** The on-chain ledger
  says what players are owed; the treasury's NEAR AI balance is what honours it.
  `get_pool` publishes `total_distributed`, `total_spent`, `sale_reserve` and
  the epoch so the two can be reconciled publicly, but the backing itself is
  custodial, and buying credits is a manual step.
- **Nothing is on mainnet yet.** Multichain minting, real mint revenue and real
  creator royalties all wait on it. The account plan, the ~16 NEAR it needs,
  and the numbers testnet never had to get right — mint and species price,
  owner keys, treasury, first `epoch_target` — are in [MAINNET.md](MAINNET.md).
- **`get_pet_state.attackable` still reads `false` for a staked pet.** The
  view predates the rule change; `is_attackable` is the one battles use. Worth
  aligning so a client reading the view does not hide valid opponents.
- **The replay guard on `/api/ai/chat` is in memory.** Fine for one instance;
  point it at Redis or Vercel KV before more than one runs.
- **Randomness is the block seed.** Good enough for loot rolls and the ±15%
  battle band; a validator could in principle bias it, so nothing of real value
  hangs on a single roll.
