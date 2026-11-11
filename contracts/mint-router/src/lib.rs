//! Multichain mint receiver.
//!
//! A player pays in ZEC, SOL, BTC or anything else NEAR Intents supports. The
//! 1Click service swaps it and withdraws wNEAR to this contract with
//! `ft_transfer_call`, carrying the `customRecipientMsg` the app set on the
//! quote. This contract turns that payment into a pet (or into $JOY).
//!
//! The payment arrives from a bridge, not from the player's own wallet, so the
//! player never signs anything on NEAR for the mint. That means this contract
//! has to be careful: the only thing it trusts is the wNEAR transfer itself,
//! and every mint it cannot complete immediately is kept as a pending claim
//! instead of being dropped.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::UnorderedMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::json;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

// Kept modest on purpose: `ft_on_transfer` runs on gas the bridge attached, not
// gas we chose. A mint that runs out of gas stays claimable through
// `redeem_pending`, so being frugal here costs nothing.
const GAS_FOR_MINT: Gas = Gas::from_tgas(30);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(10);
const GAS_FOR_CREDIT_GRANT: Gas = Gas::from_tgas(20);
const GAS_FOR_CREDIT_RESOLVE: Gas = Gas::from_tgas(5);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_UNWRAP: Gas = Gas::from_tgas(10);
/// The callback that pays the game: it schedules the mint and its own resolve.
const GAS_FOR_ON_UNWRAPPED: Gas = Gas::from_tgas(50);

const MAX_QUANTITY: u32 = 10;

/// A species id the game could hold: the shape the game contract enforces,
/// checked here only so a typo is refunded at once instead of becoming a
/// paid claim that can never mint. Whether the species exists is the game's
/// call — any registered species can be bought from any chain.
fn plausible_species(id: &str) -> bool {
    // The same rule as the game's `species_id_error`.
    (3..=24).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Pending,
}

/// What the app put in `customRecipientMsg` when it asked 1Click for a quote.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", tag = "action", rename_all = "snake_case")]
enum PaymentMsg {
    MintPet {
        account_id: AccountId,
        category: String,
        name: String,
        #[serde(default = "one")]
        quantity: u32,
    },
    BuyCredits {
        account_id: AccountId,
    },
}

fn one() -> u32 {
    1
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PendingMint {
    pub category: String,
    pub name: String,
    pub paid: U128,
    pub created_at: U64,
    /// Whether `paid` has already been turned from wNEAR into NEAR. A retry
    /// after the game refused the mint must not unwrap it a second time.
    #[serde(default)]
    pub unwrapped: bool,
}

/// What this contract needs from the game contract: mint a pet and assign it to
/// somebody other than the caller, because the caller here is a bridge.
#[ext_contract(ext_game)]
#[allow(dead_code)]
trait Game {
    fn create_pet_for(&mut self, owner_id: AccountId, name: String, category: String) -> u64;
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait Ft {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    /// wNEAR → NEAR, sent to the caller.
    fn near_withdraw(&mut self, amount: U128);
}

/// The staking contract holds the credit ledger and never takes payment — this
/// router is the only account in the system that custodies funds. It grants
/// credits on our say-so and reports how many its reserve could cover.
#[ext_contract(ext_stake)]
#[allow(dead_code)]
trait Stake {
    fn grant_credits(&mut self, account_id: AccountId, credits: U128) -> U128;
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait SelfCallbacks {
    fn on_unwrapped(&mut self, account_id: AccountId, index: u64) -> Promise;
    fn on_minted(&mut self, account_id: AccountId, index: u64) -> bool;
    fn on_credits_granted(&mut self, account_id: AccountId, paid: U128) -> U128;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MintRouter {
    owner_id: AccountId,
    game_contract: AccountId,
    /// Credit ledger. Credits bought here are granted there.
    stake_contract: AccountId,
    /// wNEAR — the only token 1Click settles into for us.
    wnear: AccountId,
    treasury: AccountId,

    /// Price of one pet, in yoctoNEAR of wNEAR.
    mint_price: u128,
    /// yoctoNEAR of wNEAR for one AI credit.
    near_per_credit: u128,

    /// Mints that have been paid for but not yet created on the game contract.
    pending: UnorderedMap<AccountId, Vec<PendingMint>>,

    total_minted: u64,
    total_received: u128,
}

#[near]
impl MintRouter {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_id: AccountId,
        game_contract: AccountId,
        stake_contract: AccountId,
        wnear: AccountId,
        treasury: AccountId,
        mint_price: U128,
        near_per_credit: U128,
    ) -> Self {
        Self {
            owner_id,
            game_contract,
            stake_contract,
            wnear,
            treasury,
            mint_price: mint_price.0,
            near_per_credit: near_per_credit.0,
            pending: UnorderedMap::new(StorageKey::Pending),
            total_minted: 0,
            total_received: 0,
        }
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can call this"
        );
    }

    fn log_event(&self, event: &str, data: near_sdk::serde_json::Value) {
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({
                "standard": "joygotchi",
                "version": "1.0.0",
                "event": event,
                "data": [data],
            })
        ));
    }

    // ── Minting ──────────────────────────────────────────────────────────────

    fn queue_mint(&mut self, account_id: &AccountId, mint: PendingMint) -> u64 {
        let mut queue = self.pending.get(account_id).unwrap_or_default();
        queue.push(mint);
        let index = (queue.len() - 1) as u64;
        self.pending.insert(account_id, &queue);
        index
    }

    /// Pay the game for one pending mint, unwrapping its wNEAR first.
    ///
    /// The game contract takes NEAR, not wNEAR, and it is the game that pays a
    /// species' creator their cut — so the payment is turned back into NEAR
    /// and attached to `create_pet_for`, exactly as a player's own mint is.
    /// That is two steps because a deposit has to be on hand when the promise
    /// carrying it is made: unwrap, then pay from the callback.
    fn start_mint(&mut self, account_id: AccountId, index: u64) -> Promise {
        let mint = self.pending_at(&account_id, index);
        if mint.unwrapped {
            return self.pay_game(account_id, index, mint);
        }
        ext_ft::ext(self.wnear.clone())
            .with_static_gas(GAS_FOR_UNWRAP)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .near_withdraw(mint.paid)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_UNWRAPPED)
                    .on_unwrapped(account_id, index),
            )
    }

    fn pending_at(&self, account_id: &AccountId, index: u64) -> PendingMint {
        self.pending
            .get(account_id)
            .unwrap_or_default()
            .get(index as usize)
            .expect("No pending mint at that index")
            .clone()
    }

    fn pay_game(&mut self, account_id: AccountId, index: u64, mint: PendingMint) -> Promise {
        ext_game::ext(self.game_contract.clone())
            .with_static_gas(GAS_FOR_MINT)
            .with_attached_deposit(NearToken::from_yoctonear(mint.paid.0))
            .create_pet_for(account_id.clone(), mint.name, mint.category)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .on_minted(account_id, index),
            )
    }

    /// The wNEAR is NEAR now: record that, then pay the game with it.
    ///
    /// If the unwrap failed the claim simply stays pending as it was. If the
    /// game later refuses the mint, its deposit comes back here and the claim
    /// keeps `unwrapped`, so `redeem_pending` pays from the NEAR on hand.
    #[private]
    pub fn on_unwrapped(
        &mut self,
        account_id: AccountId,
        index: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> PromiseOrValue<bool> {
        if result.is_err() {
            self.log_event(
                "mint_deferred",
                json!({ "account_id": account_id, "index": U64(index), "reason": "unwrap failed" }),
            );
            return PromiseOrValue::Value(false);
        }
        let mut queue = self.pending.get(&account_id).unwrap_or_default();
        let Some(mint) = queue.get_mut(index as usize) else {
            return PromiseOrValue::Value(false);
        };
        mint.unwrapped = true;
        let mint = mint.clone();
        self.pending.insert(&account_id, &queue);
        PromiseOrValue::Promise(self.pay_game(account_id, index, mint))
    }

    #[private]
    pub fn on_minted(
        &mut self,
        account_id: AccountId,
        index: u64,
        #[callback_result] result: Result<u64, PromiseError>,
    ) -> bool {
        match result {
            Ok(pet_id) => {
                let mut queue = self.pending.get(&account_id).unwrap_or_default();
                if (index as usize) < queue.len() {
                    queue.remove(index as usize);
                    if queue.is_empty() {
                        self.pending.remove(&account_id);
                    } else {
                        self.pending.insert(&account_id, &queue);
                    }
                }
                self.total_minted += 1;
                self.log_event(
                    "pet_minted",
                    json!({ "account_id": account_id, "pet_id": pet_id }),
                );
                true
            }
            Err(_) => {
                // The payment is already recorded, so keep the claim alive
                // rather than losing it.
                self.log_event(
                    "mint_deferred",
                    json!({ "account_id": account_id, "index": U64(index) }),
                );
                false
            }
        }
    }

    /// Retry a mint that the game contract rejected earlier — for example
    /// because it was paused when the payment landed. Anyone may call this; it
    /// can only ever mint a pet that has already been paid for.
    pub fn redeem_pending(&mut self, account_id: AccountId, index: U64) -> Promise {
        self.start_mint(account_id, index.0)
    }

    // ── Views ────────────────────────────────────────────────────────────────

    pub fn get_pending(&self, account_id: AccountId) -> Vec<PendingMint> {
        self.pending.get(&account_id).unwrap_or_default()
    }

    pub fn get_stats(&self) -> near_sdk::serde_json::Value {
        json!({
            "mint_price": U128(self.mint_price),
            "near_per_credit": U128(self.near_per_credit),
            "stake_contract": self.stake_contract,
            "total_minted": U64(self.total_minted),
            "total_received": U128(self.total_received),
            "pending_accounts": self.pending.len(),
            "game_contract": self.game_contract,
            "wnear": self.wnear,
            "treasury": self.treasury,
        })
    }

    // ── Owner ────────────────────────────────────────────────────────────────

    pub fn set_mint_price(&mut self, mint_price: U128) {
        self.assert_owner();
        require!(mint_price.0 > 0, "Price must be positive");
        self.mint_price = mint_price.0;
    }

    pub fn set_near_per_credit(&mut self, near_per_credit: U128) {
        self.assert_owner();
        require!(near_per_credit.0 > 0, "Rate must be positive");
        self.near_per_credit = near_per_credit.0;
    }

    pub fn set_game_contract(&mut self, game_contract: AccountId) {
        self.assert_owner();
        self.game_contract = game_contract;
    }

    /// Forward collected wNEAR to the treasury, which is what gets staked with
    /// NEAR AI to produce the credit stream the AI Lab distributes.
    pub fn sweep(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        ext_ft::ext(self.wnear.clone())
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .ft_transfer(self.treasury.clone(), amount, Some("mint revenue".to_string()))
    }
}

#[near]
impl FungibleTokenReceiver for MintRouter {
    /// Entry point for every multichain payment. 1Click calls this with the
    /// swapped wNEAR and the message the app attached to the quote.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.wnear,
            "This contract only accepts wNEAR"
        );

        let Ok(payload) = near_sdk::serde_json::from_str::<PaymentMsg>(&msg) else {
            env::log_str("Unrecognised payment message — refunding");
            return PromiseOrValue::Value(amount);
        };

        match payload {
            PaymentMsg::MintPet {
                account_id,
                category,
                name,
                quantity,
            } => {
                let quantity = quantity.clamp(1, MAX_QUANTITY);

                if !plausible_species(&category) {
                    env::log_str("Not a species id — refunding");
                    return PromiseOrValue::Value(amount);
                }

                let required = self.mint_price * quantity as u128;
                if amount.0 < required {
                    env::log_str("Payment is below the mint price — refunding");
                    return PromiseOrValue::Value(amount);
                }

                self.total_received += required;

                let name = name.chars().take(32).collect::<String>();
                let mut first_index = None;
                for _ in 0..quantity {
                    let index = self.queue_mint(
                        &account_id,
                        PendingMint {
                            category: category.clone(),
                            name: name.clone(),
                            paid: U128(self.mint_price),
                            created_at: U64(env::block_timestamp()),
                            unwrapped: false,
                        },
                    );
                    if first_index.is_none() {
                        first_index = Some(index);
                    }
                }

                self.log_event(
                    "mint_paid",
                    json!({
                        "account_id": account_id,
                        "sender_id": sender_id,
                        "category": category,
                        "quantity": quantity,
                        "paid": U128(required),
                    }),
                );

                // Kick off the first mint; the rest stay claimable through
                // `redeem_pending`, which keeps this call's gas predictable.
                //
                // The promise is scheduled as soon as it is built, so dropping
                // the handle here still runs the mint. We deliberately return a
                // value rather than the promise: the value is the refund amount
                // NEP-141 expects, and any overpayment has to go back to 1Click
                // so it reaches the player's refund address on the origin chain.
                drop(self.start_mint(account_id, first_index.unwrap_or(0)));
                PromiseOrValue::Value(U128(amount.0 - required))
            }

            PaymentMsg::BuyCredits { account_id } => {
                /// Credits carry 6 decimals, matching `pet-stake`.
                const ONE_CREDIT: u128 = 1_000_000;

                let credits = amount.0 * ONE_CREDIT / self.near_per_credit;
                if credits == 0 {
                    env::log_str("Payment is too small for a single credit — refunding");
                    return PromiseOrValue::Value(amount);
                }

                self.log_event(
                    "credits_paid",
                    json!({ "account_id": account_id, "wnear": amount, "credits": U128(credits) }),
                );

                PromiseOrValue::Promise(
                    ext_stake::ext(self.stake_contract.clone())
                        .with_static_gas(GAS_FOR_CREDIT_GRANT)
                        .grant_credits(account_id.clone(), U128(credits))
                        .then(
                            ext_self::ext(env::current_account_id())
                                .with_static_gas(GAS_FOR_CREDIT_RESOLVE)
                                .on_credits_granted(account_id, amount),
                        ),
                )
            }
        }
    }
}

#[near]
impl MintRouter {
    /// Terminates the `buy_credits` chain with the amount of wNEAR to refund.
    ///
    /// The staking contract reports how many credits its reserve could cover,
    /// which may be none. Refunding in that case is the whole point: without
    /// it a player pays and receives nothing.
    #[private]
    pub fn on_credits_granted(
        &mut self,
        account_id: AccountId,
        paid: U128,
        #[callback_result] result: Result<U128, PromiseError>,
    ) -> U128 {
        match result {
            Ok(granted) if granted.0 > 0 => {
                self.total_received += paid.0;
                self.log_event(
                    "credits_granted",
                    json!({ "account_id": account_id, "credits": granted }),
                );
                U128(0)
            }
            Ok(_) => {
                self.log_event(
                    "credit_reserve_empty",
                    json!({ "account_id": account_id, "refunded": paid }),
                );
                paid
            }
            Err(_) => {
                self.log_event(
                    "credit_grant_failed",
                    json!({ "account_id": account_id, "refunded": paid }),
                );
                paid
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn owner() -> AccountId {
        "owner.near".parse().unwrap()
    }
    fn game() -> AccountId {
        "game.near".parse().unwrap()
    }
    fn stake() -> AccountId {
        "stake.near".parse().unwrap()
    }
    fn wnear() -> AccountId {
        "wrap.near".parse().unwrap()
    }
    fn treasury() -> AccountId {
        "treasury.near".parse().unwrap()
    }
    fn alice() -> AccountId {
        "alice.near".parse().unwrap()
    }
    /// 1Click's withdrawal account.
    fn bridge() -> AccountId {
        "intents.near".parse().unwrap()
    }

    const ONE_NEAR: u128 = 10u128.pow(24);

    fn ctx(predecessor: AccountId) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("mint.near".parse().unwrap())
            .predecessor_account_id(predecessor)
            .block_timestamp(1_000);
        builder
    }

    fn deploy() -> MintRouter {
        testing_env!(ctx(owner()).build());
        MintRouter::new(
            owner(),
            game(),
            stake(),
            wnear(),
            treasury(),
            U128(2 * ONE_NEAR),
            // 0.5 NEAR per credit.
            U128(5 * 10u128.pow(23)),
        )
    }

    fn mint_msg(quantity: u32) -> String {
        json!({
            "action": "mint_pet",
            "account_id": "alice.near",
            "category": "blackdragon",
            "name": "SMAUG",
            "quantity": quantity,
        })
        .to_string()
    }

    fn value_of(result: PromiseOrValue<U128>) -> u128 {
        match result {
            PromiseOrValue::Value(value) => value.0,
            PromiseOrValue::Promise(_) => panic!("expected an immediate value"),
        }
    }

    #[test]
    fn exact_payment_queues_one_mint_and_refunds_nothing() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());

        let change = value_of(contract.ft_on_transfer(bridge(), U128(2 * ONE_NEAR), mint_msg(1)));

        assert_eq!(change, 0);
        let pending = contract.get_pending(alice());
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].category, "blackdragon");
        assert_eq!(pending[0].name, "SMAUG");
    }

    #[test]
    fn overpayment_is_returned_as_change() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());

        let change = value_of(contract.ft_on_transfer(bridge(), U128(3 * ONE_NEAR), mint_msg(1)));

        assert_eq!(change, ONE_NEAR);
    }

    #[test]
    fn underpayment_is_refunded_in_full_and_mints_nothing() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());

        let refund = value_of(contract.ft_on_transfer(bridge(), U128(ONE_NEAR), mint_msg(1)));

        assert_eq!(refund, ONE_NEAR);
        assert!(contract.get_pending(alice()).is_empty());
    }

    #[test]
    fn bulk_payment_queues_every_pet() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());

        let change = value_of(contract.ft_on_transfer(bridge(), U128(6 * ONE_NEAR), mint_msg(3)));

        assert_eq!(change, 0);
        assert_eq!(contract.get_pending(alice()).len(), 3);
    }

    #[test]
    fn a_malformed_species_id_is_refunded() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());

        let msg = json!({
            "action": "mint_pet",
            "account_id": "alice.near",
            "category": "Uni Corn!",
            "name": "NOPE",
        })
        .to_string();

        let refund = value_of(contract.ft_on_transfer(bridge(), U128(2 * ONE_NEAR), msg));
        assert_eq!(refund, 2 * ONE_NEAR);
        assert!(contract.get_pending(alice()).is_empty());
    }

    #[test]
    fn garbled_message_is_refunded() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());

        let refund = value_of(contract.ft_on_transfer(bridge(), U128(2 * ONE_NEAR), "{}".to_string()));
        assert_eq!(refund, 2 * ONE_NEAR);
    }

    #[test]
    #[should_panic(expected = "only accepts wNEAR")]
    fn rejects_other_tokens() {
        let mut contract = deploy();
        testing_env!(ctx(stake()).build());
        let _ = contract.ft_on_transfer(bridge(), U128(2 * ONE_NEAR), mint_msg(1));
    }

    #[test]
    fn buying_credits_forwards_to_the_staking_contract() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());

        let msg = json!({ "action": "buy_credits", "account_id": "alice.near" }).to_string();
        // 1 NEAR at 0.5 NEAR per credit is two credits, so this goes on to the
        // staking contract rather than being refunded on the spot.
        match contract.ft_on_transfer(bridge(), U128(ONE_NEAR), msg) {
            PromiseOrValue::Promise(_) => {}
            PromiseOrValue::Value(_) => panic!("expected a cross-contract call"),
        }
    }

    #[test]
    fn dust_payments_are_refunded_rather_than_rounded_away() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());

        let msg = json!({ "action": "buy_credits", "account_id": "alice.near" }).to_string();
        let refund = value_of(contract.ft_on_transfer(bridge(), U128(1_000), msg));
        assert_eq!(refund, 1_000, "too small for one credit, so give it back");
    }

    #[test]
    fn a_grant_that_does_not_land_refunds_the_payment() {
        let mut contract = deploy();
        testing_env!(ctx("mint.near".parse().unwrap()).build());

        // The staking contract's reserve could not cover it.
        assert_eq!(
            contract.on_credits_granted(alice(), U128(ONE_NEAR), Ok(U128(0))).0,
            ONE_NEAR
        );
        // The call itself failed.
        assert_eq!(
            contract
                .on_credits_granted(alice(), U128(ONE_NEAR), Err(PromiseError::Failed))
                .0,
            ONE_NEAR
        );
        // It worked: nothing to refund.
        assert_eq!(
            contract
                .on_credits_granted(alice(), U128(ONE_NEAR), Ok(U128(2_000_000)))
                .0,
            0
        );
    }

    #[test]
    fn successful_callback_clears_the_pending_entry() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());
        let _ = contract.ft_on_transfer(bridge(), U128(2 * ONE_NEAR), mint_msg(1));

        testing_env!(ctx("mint.near".parse().unwrap()).build());
        assert!(contract.on_minted(alice(), 0, Ok(42)));
        assert!(contract.get_pending(alice()).is_empty());
    }

    #[test]
    fn failed_callback_keeps_the_claim() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());
        let _ = contract.ft_on_transfer(bridge(), U128(2 * ONE_NEAR), mint_msg(1));

        testing_env!(ctx("mint.near".parse().unwrap()).build());
        assert!(!contract.on_minted(alice(), 0, Err(PromiseError::Failed)));
        assert_eq!(contract.get_pending(alice()).len(), 1, "the paid mint must survive");
    }

    #[test]
    fn any_registered_species_can_be_bought_from_another_chain() {
        // The router used to accept the two shipped dragons and nothing else,
        // so a creator's species could only be bought with NEAR.
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());
        let msg = json!({
            "action": "mint_pet",
            "account_id": "alice.near",
            "category": "wyvern",
            "name": "AZURE",
        })
        .to_string();

        let change = value_of(contract.ft_on_transfer(bridge(), U128(2 * ONE_NEAR), msg));
        assert_eq!(change, 0);
        assert_eq!(contract.get_pending(alice())[0].category, "wyvern");
        assert!(!contract.get_pending(alice())[0].unwrapped);
    }

    #[test]
    fn an_unwrapped_claim_remembers_it_so_a_retry_does_not_unwrap_twice() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());
        let _ = contract.ft_on_transfer(bridge(), U128(2 * ONE_NEAR), mint_msg(1));

        testing_env!(ctx("mint.near".parse().unwrap()).build());
        let _ = contract.on_unwrapped(alice(), 0, Ok(()));
        assert!(contract.get_pending(alice())[0].unwrapped);

        // The game refused it: the claim survives, still unwrapped.
        assert!(!contract.on_minted(alice(), 0, Err(PromiseError::Failed)));
        assert!(contract.get_pending(alice())[0].unwrapped);
    }

    #[test]
    fn a_failed_unwrap_leaves_the_claim_as_it_was() {
        let mut contract = deploy();
        testing_env!(ctx(wnear()).build());
        let _ = contract.ft_on_transfer(bridge(), U128(2 * ONE_NEAR), mint_msg(1));

        testing_env!(ctx("mint.near".parse().unwrap()).build());
        let _ = contract.on_unwrapped(alice(), 0, Err(PromiseError::Failed));
        assert!(!contract.get_pending(alice())[0].unwrapped);
    }

    #[test]
    fn species_ids_are_checked_for_shape_only() {
        assert!(plausible_species("blackdragon"));
        assert!(plausible_species("wyvern2"));
        assert!(!plausible_species("ab"));
        assert!(plausible_species("2fast"), "the game allows a leading digit");
        assert!(!plausible_species("Wyvern"));
        assert!(!plausible_species("wy-vern"));
    }
}
