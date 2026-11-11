//! Does `migrate` read what is actually on chain right now?
//!
//! This project has lost two deployments to a Borsh layout mismatch, and
//! both times every test passed first. The reason is that a unit test
//! constructs the old struct in memory with the same compiler that will
//! read it back, so it agrees with itself and proves nothing about the
//! bytes a different binary wrote months ago.
//!
//! So this reads the real bytes. `fixtures/game-state.bin` is the `STATE`
//! key of `jg-game-5656.testnet`, fetched from an RPC, and the test
//! deserialises it with the same `OldGame` layout `migrate` uses. If the
//! field order in `migrate` ever drifts from what is deployed, this fails
//! here instead of on chain.
//!
//! Refresh it with:
//!
//! ```text
//! curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
//!   -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
//!         "request_type":"view_state","finality":"final",
//!         "account_id":"jg-game-5656.testnet","prefix_base64":"U1RBVEU="}}' \
//!   | python3 -c 'import json,sys,base64; print(end=""); \
//!       sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["result"]["values"][0]["value"]))' \
//!   > contracts/game/tests/fixtures/game-state.bin
//! ```

use game::{Pet, PetListing, ShopItem};
use near_contract_standards::non_fungible_token::metadata::NFTContractMetadata;
use near_contract_standards::non_fungible_token::NonFungibleToken;
use near_sdk::borsh::BorshDeserialize;
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::AccountId;

/// The deployed layout, copied from `migrate`. Field order is the layout.
#[derive(BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
#[allow(dead_code)]
struct OldGame {
    tokens: NonFungibleToken,
    metadata: NFTContractMetadata,
    owner_id: AccountId,
    stake_contract: AccountId,
    mint_router: AccountId,
    pets: UnorderedMap<u64, Pet>,
    next_pet_id: u64,
    shop: LookupMap<u16, ShopItem>,
    shop_ids: Vec<u16>,
    mint_price: u128,
    listings: UnorderedMap<u64, PetListing>,
    market_fee_bps: u16,
    treasury: AccountId,
    paused: bool,
}

#[test]
fn migrate_reads_the_state_that_is_deployed_today() {
    let bytes = include_bytes!("fixtures/game-state.bin");
    let old = OldGame::try_from_slice(bytes)
        .expect("migrate's OldGame does not match what is on chain");

    // Values worth checking by eye, so a layout that happens to parse into
    // nonsense is caught as well as one that fails outright.
    // What `get_config` reports for this account today. The contract owns
    // itself: owner-only calls need a full-access key on it, which is also
    // what signs a deploy, which is what makes `migrate` reachable.
    assert_eq!(old.owner_id.as_str(), "jg-game-5656.testnet");
    assert_eq!(old.stake_contract.as_str(), "jg-stake-5656.testnet");
    assert_eq!(old.mint_router.as_str(), "jg-mint-5656.testnet");
    assert_eq!(old.treasury.as_str(), "jg-mint-5656.testnet");
    assert_eq!(old.mint_price, 2_000_000_000_000_000_000_000_000);
    assert_eq!(old.market_fee_bps, 250);
    assert_eq!(old.next_pet_id, 9, "eight pets minted so far");
    assert!(!old.paused);
}

#[test]
fn the_fixture_is_consumed_whole() {
    // A layout that is a prefix of the real one parses happily and leaves
    // bytes over — which is exactly a field added at the end going unread.
    let bytes = include_bytes!("fixtures/game-state.bin");
    let mut slice: &[u8] = bytes;
    OldGame::deserialize(&mut slice).expect("should parse");
    assert!(slice.is_empty(), "{} bytes left unread", slice.len());
}
