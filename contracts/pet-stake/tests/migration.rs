//! Does `migrate_epochs` read what is actually on chain right now?
//!
//! The same guard the game contract has, for the same reason: a unit test
//! builds the old struct with the compiler that reads it back, so it agrees
//! with itself and proves nothing about bytes a different binary wrote. The
//! staking contract had no such test, and a field added to `PetAttrs` once
//! broke every staked record on testnet while every test passed.
//!
//! `fixtures/stake-state.bin` is the `STATE` key of `jg-stake-5656.testnet`.
//! Refresh it with:
//!
//! ```text
//! curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
//!   -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
//!         "request_type":"view_state","finality":"final",
//!         "account_id":"jg-stake-5656.testnet","prefix_base64":"U1RBVEU="}}' \
//!   | python3 -c 'import json,sys,base64; \
//!       sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["result"]["values"][0]["value"]))' \
//!   > contracts/pet-stake/tests/fixtures/stake-state.bin
//! ```

use near_sdk::borsh::BorshDeserialize;
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::AccountId;
use pet_stake::{Account, AutoFeedWindow, Listing, PetState, StakedPet};

/// The deployed layout, copied from `migrate_epochs`'s `PetStakeV4`. Field
/// order is the layout.
#[derive(BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
#[allow(dead_code)]
struct PetStakeV4 {
    owner_id: AccountId,
    game_contract: AccountId,
    granter: AccountId,
    epoch_budget: u128,
    total_weight: u128,
    acc_credit_per_weight: u128,
    updated_at: u64,
    accounts: UnorderedMap<AccountId, Account>,
    pets: UnorderedMap<u64, StakedPet>,
    prices: LookupMap<String, u128>,
    pet_states: UnorderedMap<u64, PetState>,
    item_prices: LookupMap<u16, u128>,
    battle_wager: u128,
    battle_rake_bps: u16,
    total_distributed: u128,
    total_spent: u128,
    sale_reserve: u128,
    faucet_amount: u128,
    mining_reward: u128,
    listings: UnorderedMap<u64, Listing>,
    next_listing_id: u64,
    market_rake_bps: u16,
    paused: bool,
    oracle: AccountId,
    auto_feed_spend: LookupMap<AccountId, AutoFeedWindow>,
    graded_meals: LookupMap<String, u64>,
}

#[test]
fn migrate_epochs_reads_the_state_that_is_deployed_today() {
    let bytes = include_bytes!("fixtures/stake-state.bin");
    let mut slice: &[u8] = bytes;
    let old = PetStakeV4::deserialize(&mut slice)
        .expect("PetStakeV4 does not match what is on chain");

    // Every byte consumed: a layout that reads short would leave some over,
    // which is how a missing field hides.
    assert!(slice.is_empty(), "{} bytes left over", slice.len());
    assert_eq!(old.owner_id.as_str(), "jg-stake-5656.testnet");
    assert_eq!(old.game_contract.as_str(), "jg-game-5656.testnet");
    assert!(old.epoch_budget > 0, "the live pool is funded");
}
