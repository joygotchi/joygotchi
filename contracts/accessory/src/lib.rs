/*!
Accessories a pet can wear, as NEP-171 tokens.

A hat here is a token like any other: it is owned, it transfers, and it sells
on any NEAR marketplace without this contract writing one. What it also does
is get worn, and the state for that lives here rather than on the game
contract — deliberately.

The game contract's `Pet` struct is Borsh in a map with every pet in it.
Adding `equipped: Option<TokenId>` there would be a layout change needing a
migration, and this repository has taken a live deployment down doing exactly
that (see `contracts/DEPLOYED.md`). Keeping the association in this contract
means the game and the staking contracts are not touched at all: a pet does
not know what it is wearing, and does not need to.

The one thing that cannot be done from here is check that the person
equipping a hat owns the pet, because that fact lives on the game contract.
So `equip` asks it, and applies the change in the callback.
*/
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::{LazyOption, LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

mod types;
pub use types::{Kind, WornView};

const GAS_FOR_OWNER_LOOKUP: Gas = Gas::from_tgas(10);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(10);

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    NonFungibleToken,
    Metadata,
    TokenMetadata,
    Enumeration,
    Approval,
    Kinds,
    WornByPet,
    WornOn,
}

/// Only the NEP-171 half of the game contract is used, so that is all this
/// declares. Asking for `get_pet_attrs` would couple the two contracts'
/// private types together for a fact the standard already exposes.
#[allow(dead_code)]
#[ext_contract(ext_game)]
trait Game {
    fn nft_token(&self, token_id: TokenId) -> Option<Token>;
}

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait Resolver {
    fn on_pet_owner(
        &mut self,
        token_id: TokenId,
        pet_id: u64,
        wearer: AccountId,
    ) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Accessory {
    owner_id: AccountId,
    /// The contract whose pets these are worn by.
    game_contract: AccountId,
    /// Where mint payments land. This contract keeps nothing.
    treasury: AccountId,

    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,

    kinds: UnorderedMap<String, Kind>,
    /// What each pet is wearing.
    worn_by_pet: LookupMap<u64, TokenId>,
    /// And the reverse, so a transfer can undo it without scanning.
    worn_on: LookupMap<TokenId, u64>,

    next_id: u64,
}

#[near]
impl Accessory {
    #[init]
    pub fn new(owner_id: AccountId, game_contract: AccountId, treasury: AccountId) -> Self {
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "JOYGOTCHI Accessories".to_string(),
            symbol: "JGACC".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };

        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NonFungibleToken,
                owner_id.clone(),
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approval),
            ),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            kinds: UnorderedMap::new(StorageKey::Kinds),
            worn_by_pet: LookupMap::new(StorageKey::WornByPet),
            worn_on: LookupMap::new(StorageKey::WornOn),
            owner_id,
            game_contract,
            treasury,
            next_id: 1,
        }
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can call this"
        );
    }

    /// Add something mintable.
    ///
    /// The cap cannot be changed afterwards, and that is the point of it: a
    /// limited run whose limit can be raised later is not a limited run.
    pub fn add_kind(
        &mut self,
        slug: String,
        name: String,
        price: U128,
        supply_cap: u32,
        art: String,
    ) {
        self.assert_owner();
        require!(self.kinds.get(&slug).is_none(), "That kind already exists");
        require!(!slug.is_empty() && slug.len() <= 32, "Bad slug");

        self.kinds.insert(
            &slug,
            &Kind {
                slug: slug.clone(),
                name,
                price,
                supply_cap,
                minted: 0,
                art,
            },
        );
        self.log_event("kind_added", json!({ "slug": slug }));
    }

    /// Withdraw a kind, but only while nobody owns one.
    ///
    /// Once a single token exists the kind is somebody's property and its
    /// art, its name and its cap are part of what they hold. Before that it
    /// is a listing, and a listing can be taken down.
    pub fn remove_kind(&mut self, slug: String) {
        self.assert_owner();
        let kind = self.kinds.get(&slug).expect("Unknown kind");
        require!(
            kind.minted == 0,
            "Somebody already owns one of these; it cannot be withdrawn"
        );
        self.kinds.remove(&slug);
        self.log_event("kind_removed", json!({ "slug": slug }));
    }

    /// Only the price may move. Everything else about a kind is a promise.
    pub fn set_price(&mut self, slug: String, price: U128) {
        self.assert_owner();
        let mut kind = self.kinds.get(&slug).expect("Unknown kind");
        kind.price = price;
        self.kinds.insert(&slug, &kind);
    }

    /// Buy one. The deposit goes to the treasury, not to this contract.
    #[payable]
    pub fn mint(&mut self, kind: String) -> TokenId {
        let mut found = self.kinds.get(&kind).expect("Unknown kind");
        require!(!found.sold_out(), "That one is sold out");

        let paid = env::attached_deposit();

        let owner_id = env::predecessor_account_id();
        let token_id = self.next_id.to_string();
        self.next_id += 1;
        let before = env::storage_usage();

        let metadata = TokenMetadata {
            title: Some(found.name.clone()),
            description: None,
            media: Some(found.art.clone()),
            media_hash: None,
            copies: if found.supply_cap == 0 {
                None
            } else {
                Some(found.supply_cap as u64)
            },
            issued_at: Some(env::block_timestamp().to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            // The slug, so the app can draw it without a second lookup.
            extra: Some(found.slug.clone()),
            reference: None,
            reference_hash: None,
        };

        /*
         * `internal_mint` refunds whatever is left after storage to the
         * minter, which would hand the price straight back and leave this
         * contract paying the treasury out of its own balance. The
         * `_with_refund(.., None)` form keeps the deposit here, and the
         * accounting below is then ours to do.
         */
        self.tokens.internal_mint_with_refund(
            token_id.clone(),
            owner_id.clone(),
            Some(metadata),
            None,
        );

        let storage_cost = env::storage_byte_cost()
            .saturating_mul(env::storage_usage().saturating_sub(before) as u128);
        let owed = NearToken::from_yoctonear(found.price.0).saturating_add(storage_cost);
        require!(
            paid >= owed,
            format!(
                "Attach at least {} — the price plus {} of storage",
                owed.exact_amount_display(),
                storage_cost.exact_amount_display()
            )
        );

        found.minted += 1;
        self.kinds.insert(&kind, &found);

        // The price to the treasury; anything over price-plus-storage back to
        // the buyer. Constructing a Promise schedules it, and there is nothing
        // to chain onto a payout.
        if found.price.0 > 0 {
            let _payout = Promise::new(self.treasury.clone())
                .transfer(NearToken::from_yoctonear(found.price.0));
        }
        let change = paid.saturating_sub(owed);
        if change.as_yoctonear() > 1 {
            let _refund = Promise::new(owner_id.clone()).transfer(change);
        }

        self.log_event(
            "accessory_minted",
            json!({ "token_id": token_id, "kind": kind, "owner_id": owner_id }),
        );
        token_id
    }

    /// Put it on a pet.
    ///
    /// Both halves have to be yours, and only one of them is knowable here:
    /// the token is in this contract, the pet is on the game contract. So the
    /// check is split, and nothing is written until the answer comes back.
    pub fn equip(&mut self, token_id: TokenId, pet_id: u64) -> Promise {
        let wearer = env::predecessor_account_id();
        let holder = self
            .tokens
            .owner_by_id
            .get(&token_id)
            .expect("No such accessory");
        require!(holder == wearer, "That accessory belongs to someone else");

        ext_game::ext(self.game_contract.clone())
            .with_static_gas(GAS_FOR_OWNER_LOOKUP)
            .nft_token(pet_id.to_string())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .on_pet_owner(token_id, pet_id, wearer),
            )
    }

    #[private]
    pub fn on_pet_owner(
        &mut self,
        token_id: TokenId,
        pet_id: u64,
        wearer: AccountId,
        #[callback_result] result: Result<Option<Token>, PromiseError>,
    ) -> bool {
        let Ok(Some(pet)) = result else {
            env::log_str("Could not read that pet from the game contract");
            return false;
        };
        if pet.owner_id != wearer {
            env::log_str("That pet belongs to someone else");
            return false;
        }

        // One hat at a time, and a hat on one pet at a time. Whatever either
        // side was wearing comes off first, or the maps disagree with each
        // other and a hat shows up twice.
        if let Some(previous) = self.worn_by_pet.get(&pet_id) {
            self.worn_on.remove(&previous);
        }
        if let Some(previous_pet) = self.worn_on.get(&token_id) {
            self.worn_by_pet.remove(&previous_pet);
        }

        self.worn_by_pet.insert(&pet_id, &token_id);
        self.worn_on.insert(&token_id, &pet_id);

        self.log_event(
            "accessory_equipped",
            json!({ "token_id": token_id, "pet_id": pet_id, "owner_id": wearer }),
        );
        true
    }

    /// Take it off. The token's owner decides, nobody else.
    pub fn unequip(&mut self, token_id: TokenId) {
        let holder = self
            .tokens
            .owner_by_id
            .get(&token_id)
            .expect("No such accessory");
        require!(
            holder == env::predecessor_account_id(),
            "That accessory belongs to someone else"
        );
        self.internal_unequip(&token_id);
    }

    fn internal_unequip(&mut self, token_id: &TokenId) {
        if let Some(pet_id) = self.worn_on.remove(token_id) {
            self.worn_by_pet.remove(&pet_id);
            self.log_event(
                "accessory_unequipped",
                json!({ "token_id": token_id, "pet_id": pet_id }),
            );
        }
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

    // ── Views ────────────────────────────────────────────────────────────────

    pub fn get_kinds(&self) -> Vec<Kind> {
        self.kinds.values().collect()
    }

    pub fn get_kind(&self, slug: String) -> Option<Kind> {
        self.kinds.get(&slug)
    }

    /// What a pet is wearing, with enough to draw it.
    pub fn worn_by(&self, pet_id: u64) -> Option<WornView> {
        let token_id = self.worn_by_pet.get(&pet_id)?;
        self.view_of(&token_id)
    }

    /// Everything an account holds here, worn or not.
    pub fn accessories_of(&self, account_id: AccountId) -> Vec<WornView> {
        let Some(per_owner) = self.tokens.tokens_per_owner.as_ref() else {
            return vec![];
        };
        let Some(ids) = per_owner.get(&account_id) else {
            return vec![];
        };
        ids.iter().filter_map(|id| self.view_of(&id)).collect()
    }

    fn view_of(&self, token_id: &TokenId) -> Option<WornView> {
        let owner_id = self.tokens.owner_by_id.get(token_id)?;
        let slug = self
            .tokens
            .token_metadata_by_id
            .as_ref()
            .and_then(|m| m.get(token_id))
            .and_then(|m| m.extra)
            .unwrap_or_default();
        let art = self.kinds.get(&slug).map(|k| k.art).unwrap_or_default();

        Some(WornView {
            token_id: token_id.clone(),
            owner_id,
            kind: slug,
            art,
            pet_id: self.worn_on.get(token_id),
        })
    }
}

// ── NEP-171 ──────────────────────────────────────────────────────────────────

#[near]
impl Accessory {
    /// The standard's transfer, with the equip undone first.
    ///
    /// Written out rather than taken from the macro because selling a hat a
    /// pet is wearing has to take it off. Leaving the maps alone would show
    /// the buyer's hat on the seller's pet until somebody noticed.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        self.internal_unequip(&token_id);
        near_contract_standards::non_fungible_token::core::NonFungibleTokenCore::nft_transfer(
            &mut self.tokens,
            receiver_id,
            token_id,
            approval_id,
            memo,
        );
    }

    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.internal_unequip(&token_id);
        near_contract_standards::non_fungible_token::core::NonFungibleTokenCore::nft_transfer_call(
            &mut self.tokens,
            receiver_id,
            token_id,
            approval_id,
            memo,
            msg,
        )
    }

    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        near_contract_standards::non_fungible_token::core::NonFungibleTokenCore::nft_token(
            &self.tokens,
            token_id,
        )
    }

    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<std::collections::HashMap<AccountId, u64>>,
    ) -> bool {
        use near_contract_standards::non_fungible_token::core::NonFungibleTokenResolver;
        self.tokens.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id,
            approved_account_ids,
        )
    }
}

/// Approval and enumeration, written out for the same reason the game
/// contract writes them out: the macros that generate them are deprecated.
#[near]
impl Accessory {
    #[payable]
    pub fn nft_approve(
        &mut self,
        token_id: TokenId,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    pub fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
        self.tokens.nft_revoke(token_id, account_id);
    }

    #[payable]
    pub fn nft_revoke_all(&mut self, token_id: TokenId) {
        use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
        self.tokens.nft_revoke_all(token_id);
    }

    pub fn nft_is_approved(
        &self,
        token_id: TokenId,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
        self.tokens
            .nft_is_approved(token_id, approved_account_id, approval_id)
    }

    pub fn nft_total_supply(&self) -> U128 {
        use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
        self.tokens.nft_total_supply()
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
        self.tokens.nft_tokens(from_index, limit)
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
        self.tokens.nft_supply_for_owner(account_id)
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Accessory {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap()
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
    fn treasury() -> AccountId {
        "treasury.near".parse().unwrap()
    }
    fn alice() -> AccountId {
        "alice.near".parse().unwrap()
    }
    fn bob() -> AccountId {
        "bob.near".parse().unwrap()
    }

    fn ctx(who: AccountId, deposit: u128) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id("acc.near".parse().unwrap())
            .predecessor_account_id(who)
            .attached_deposit(NearToken::from_yoctonear(deposit));
        b
    }

    const PRICE: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
    /// Comfortably over price plus the standard's storage charge.
    const ENOUGH: u128 = PRICE + 10_000_000_000_000_000_000_000;
    /// Enough for storage on a free kind.
    const STORAGE_ONLY: u128 = 10_000_000_000_000_000_000_000;

    fn deploy() -> Accessory {
        testing_env!(ctx(owner(), 0).build());
        let mut c = Accessory::new(owner(), game(), treasury());
        c.add_kind(
            "crown".into(),
            "Crown".into(),
            U128(PRICE),
            2,
            "/assets/hat/crown.svg".into(),
        );
        c.add_kind("cap".into(), "Cap".into(), U128(0), 0, "/assets/hat/cap.svg".into());
        c
    }

    /// `nft_token` as the game contract would answer it.
    fn pet_owned_by(who: AccountId) -> Result<Option<Token>, PromiseError> {
        Ok(Some(Token {
            token_id: "6".to_string(),
            owner_id: who,
            metadata: None,
            approved_account_ids: None,
        }))
    }

    #[test]
    fn minting_costs_what_the_kind_says() {
        let mut c = deploy();
        testing_env!(ctx(alice(), ENOUGH).build());
        let id = c.mint("crown".into());
        assert_eq!(c.nft_token(id.clone()).unwrap().owner_id, alice());
        assert_eq!(c.get_kind("crown".into()).unwrap().minted, 1);
    }

    #[test]
    #[should_panic(expected = "Attach at least")]
    fn minting_short_is_refused() {
        // The price alone is short: the token's storage has to be paid for
        // too, and if the buyer does not pay it this contract does.
        let mut c = deploy();
        testing_env!(ctx(alice(), PRICE).build());
        c.mint("crown".into());
    }

    #[test]
    #[should_panic(expected = "Attach at least")]
    fn a_free_kind_still_costs_its_storage() {
        // Free means the treasury takes nothing, not that the token is free
        // to store. Somebody pays for those bytes and it must not be here.
        let mut c = deploy();
        testing_env!(ctx(alice(), 0).build());
        c.mint("cap".into());
    }

    #[test]
    #[should_panic(expected = "sold out")]
    fn a_cap_is_a_cap() {
        // The scarcity is the product. A limit that can be passed is not one.
        let mut c = deploy();
        for _ in 0..2 {
            testing_env!(ctx(alice(), ENOUGH).build());
            c.mint("crown".into());
        }
        testing_env!(ctx(alice(), ENOUGH).build());
        c.mint("crown".into());
    }

    #[test]
    fn a_free_kind_with_no_cap_keeps_minting() {
        let mut c = deploy();
        for _ in 0..5 {
            testing_env!(ctx(alice(), STORAGE_ONLY).build());
            c.mint("cap".into());
        }
        assert_eq!(c.get_kind("cap".into()).unwrap().minted, 5);
    }

    #[test]
    fn equipping_needs_the_pet_to_be_yours_too() {
        // Owning the hat is half of it; the other half lives on the game
        // contract, which is why this arrives as a callback.
        let mut c = deploy();
        testing_env!(ctx(alice(), ENOUGH).build());
        let id = c.mint("crown".into());

        testing_env!(ctx("acc.near".parse().unwrap(), 0).build());
        let refused = c.on_pet_owner(id.clone(), 6, alice(), pet_owned_by(bob()));
        assert!(!refused, "somebody else's pet");
        assert!(c.worn_by(6).is_none());

        let accepted = c.on_pet_owner(id.clone(), 6, alice(), pet_owned_by(alice()));
        assert!(accepted);
        assert_eq!(c.worn_by(6).unwrap().token_id, id);
    }

    #[test]
    #[should_panic(expected = "belongs to someone else")]
    fn you_cannot_equip_a_hat_you_do_not_hold() {
        let mut c = deploy();
        testing_env!(ctx(alice(), ENOUGH).build());
        let id = c.mint("crown".into());

        testing_env!(ctx(bob(), 0).build());
        let _ = c.equip(id, 6);
    }

    #[test]
    fn one_hat_per_pet_and_one_pet_per_hat() {
        let mut c = deploy();
        testing_env!(ctx(alice(), ENOUGH).build());
        let first = c.mint("crown".into());
        testing_env!(ctx(alice(), STORAGE_ONLY).build());
        let second = c.mint("cap".into());

        testing_env!(ctx("acc.near".parse().unwrap(), 0).build());
        c.on_pet_owner(first.clone(), 6, alice(), pet_owned_by(alice()));
        c.on_pet_owner(second.clone(), 6, alice(), pet_owned_by(alice()));

        // The second one displaced the first, and the first is free again.
        assert_eq!(c.worn_by(6).unwrap().token_id, second);
        assert!(c.view_of(&first).unwrap().pet_id.is_none());

        // Moving the same hat to another pet leaves the first pet bare.
        c.on_pet_owner(second.clone(), 7, alice(), pet_owned_by(alice()));
        assert!(c.worn_by(6).is_none());
        assert_eq!(c.worn_by(7).unwrap().token_id, second);
    }

    #[test]
    fn selling_a_hat_takes_it_off() {
        // Otherwise the buyer's hat stays on the seller's pet until somebody
        // notices, which is the kind of thing nobody notices.
        let mut c = deploy();
        testing_env!(ctx(alice(), ENOUGH).build());
        let id = c.mint("crown".into());
        testing_env!(ctx("acc.near".parse().unwrap(), 0).build());
        c.on_pet_owner(id.clone(), 6, alice(), pet_owned_by(alice()));
        assert!(c.worn_by(6).is_some());

        testing_env!(ctx(alice(), 1).build());
        c.nft_transfer(bob(), id.clone(), None, None);

        assert!(c.worn_by(6).is_none(), "still worn after being sold");
        assert_eq!(c.nft_token(id).unwrap().owner_id, bob());
    }

    #[test]
    fn unequip_is_the_holders_call() {
        let mut c = deploy();
        testing_env!(ctx(alice(), ENOUGH).build());
        let id = c.mint("crown".into());
        testing_env!(ctx("acc.near".parse().unwrap(), 0).build());
        c.on_pet_owner(id.clone(), 6, alice(), pet_owned_by(alice()));

        testing_env!(ctx(alice(), 0).build());
        c.unequip(id);
        assert!(c.worn_by(6).is_none());
    }

    #[test]
    fn accessories_of_lists_what_somebody_holds() {
        let mut c = deploy();
        testing_env!(ctx(alice(), ENOUGH).build());
        c.mint("crown".into());
        testing_env!(ctx(alice(), STORAGE_ONLY).build());
        c.mint("cap".into());
        testing_env!(ctx(bob(), STORAGE_ONLY).build());
        c.mint("cap".into());

        assert_eq!(c.accessories_of(alice()).len(), 2);
        assert_eq!(c.accessories_of(bob()).len(), 1);
        assert_eq!(c.accessories_of(treasury()).len(), 0);
    }

    #[test]
    fn a_kind_nobody_owns_can_be_withdrawn() {
        let mut c = deploy();
        testing_env!(ctx(owner(), 0).build());
        c.remove_kind("cap".into());
        assert!(c.get_kind("cap".into()).is_none());
    }

    #[test]
    #[should_panic(expected = "already owns one")]
    fn a_kind_somebody_owns_cannot_be() {
        // The art and the cap are part of what the holder bought.
        let mut c = deploy();
        testing_env!(ctx(alice(), ENOUGH).build());
        c.mint("crown".into());
        testing_env!(ctx(owner(), 0).build());
        c.remove_kind("crown".into());
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn kinds_are_not_open_season() {
        let mut c = deploy();
        testing_env!(ctx(alice(), 0).build());
        c.add_kind("halo".into(), "Halo".into(), U128(0), 0, "x".into());
    }
}
