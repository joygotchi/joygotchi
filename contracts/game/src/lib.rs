//! JOYGOTCHI pets, v2.
//!
//! A NEP-171 collection with the game on top. Written to replace
//! `game.joyv1.near`, which is not NEP-171, has no combat stats, and stores a
//! status field it only refreshes when something touches the pet.
//!
//! The interface this implements is specified in docs/GAME_CONTRACT_V2.md.
//! Four things in it exist solely because another contract calls them:
//! `get_pet_attrs` and `create_pet_for` (called by `pet-stake` and
//! `mint-router`), `set_locked` (called by `pet-stake` when a pet starts or
//! stops work), and `attack`, which settles through `pet-stake::report_battle`.
//!
//! Five open decisions from the spec are resolved here. Each is marked
//! `DECISION:` where it is implemented, so they are easy to find and change.

mod types;

use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::events::{NftBurn, NftMint, NftTransfer};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub use types::*;

const GAS_FOR_BATTLE: Gas = Gas::from_tgas(40);
const GAS_FOR_BATTLE_RESOLVE: Gas = Gas::from_tgas(20);
const GAS_FOR_SYNC: Gas = Gas::from_tgas(30);

/// The two species this game shipped with, seeded into the registry at
/// deploy so that every pet minted before it existed still resolves.
///
/// This is a seed, not the law: `internal_mint` asks the registry, so a
/// species created after deploy mints exactly like these two. It used to be
/// the law, and that is what made a new animal cost a contract deploy.
const BUILT_IN_SPECIES: [(&str, &str); 2] =
    [("blackdragon", "Black Dragon"), ("greendragon", "Green Dragon")];

/// Where the built-in drawings are served from.
///
/// Absolute on purpose. Token metadata used to carry
/// `/assets/animation/<category>/<phase>.gif`, which resolves only inside
/// the desktop app — every wallet and every explorer drew a broken image.
const BUILT_IN_ART_BASE: &str = "https://joygotchi.vercel.app/assets/animation";

/// A species creator's cut of every mint of their species, in basis points.
///
/// One percent. Small enough that the treasury still funds the credit stream
/// staked pets are paid from — both come out of the same mint price — and
/// large enough to be a reason to make a second species rather than a
/// rounding error. It is paid at mint, not accrued: a balance somebody has
/// to come back and claim is a balance most people never claim.
const CREATOR_ROYALTY_BPS: u128 = 100;

/// What creating a species costs, in yoctoNEAR, unless the owner changes it.
///
/// A species is permanent, public, and carries its creator's name, so the
/// fee is the thing standing between the registry and a thousand squatted
/// ids. It goes where mint revenue goes.
const DEFAULT_SPECIES_PRICE: u128 = 5_000_000_000_000_000_000_000_000;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    NonFungibleToken,
    TokenMetadata,
    Enumeration,
    Approval,
    Pets,
    Shop,
    Listings,
    Species,
}

/// What this contract needs from the staking contract.
#[ext_contract(ext_stake)]
#[allow(dead_code)]
trait Stake {
    fn report_battle(
        &mut self,
        winner_pet_id: u64,
        winner_id: AccountId,
        loser_pet_id: u64,
        loser_id: AccountId,
    ) -> BattleOutcome;

    /// Re-read a staked pet's attributes after it levels up or evolves.
    fn sync_pet(&mut self, pet_id: u64);
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait SelfCallbacks {
    fn on_battle_settled(&mut self, winner_pet_id: u64, loser_pet_id: u64) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Game {
    tokens: NonFungibleToken,
    metadata: NFTContractMetadata,

    owner_id: AccountId,
    /// Allowed to call `set_locked`, and the contract battles settle through.
    stake_contract: AccountId,
    /// Allowed to call `create_pet_for`.
    mint_router: AccountId,

    pets: UnorderedMap<u64, Pet>,
    next_pet_id: u64,

    /// The shop, priced in yoctoNEAR.
    shop: LookupMap<u16, ShopItem>,
    shop_ids: Vec<u16>,

    /// What `create_pet` costs, in yoctoNEAR.
    mint_price: u128,

    /// Pets for sale, priced in NEAR.
    listings: UnorderedMap<u64, PetListing>,
    /// Marketplace cut, in basis points, paid to the treasury.
    market_fee_bps: u16,
    /// Where mint revenue and marketplace fees go.
    treasury: AccountId,

    /// Every species that can be minted, by id. A pet's `category` is a key
    /// here, which is why adding a species costs no byte on any stored pet.
    species: UnorderedMap<String, Species>,
    /// What `create_species` costs, in yoctoNEAR.
    species_price: u128,
    /// Revenue taken for pets and species and not yet swept, in yoctoNEAR.
    ///
    /// The contract's balance is not this number: it also holds the NEP-171
    /// storage staking for every token ever minted, and sweeping that would
    /// take the contract below its own storage cost. Counting what was
    /// charged is the only way to know what is safe to move.
    revenue_banked: u128,

    paused: bool,
}

#[near]
impl Game {
    #[init]
    pub fn new(
        owner_id: AccountId,
        stake_contract: AccountId,
        mint_router: AccountId,
        treasury: AccountId,
        mint_price: U128,
    ) -> Self {
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "JOYGOTCHI".to_string(),
            symbol: "JOY".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        metadata.assert_valid();

        let mut contract = Self {
            tokens: NonFungibleToken::new(
                StorageKey::NonFungibleToken,
                owner_id.clone(),
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approval),
            ),
            metadata,
            owner_id,
            stake_contract,
            mint_router,
            pets: UnorderedMap::new(StorageKey::Pets),
            next_pet_id: 1,
            shop: LookupMap::new(StorageKey::Shop),
            shop_ids: Vec::new(),
            mint_price: mint_price.0,
            listings: UnorderedMap::new(StorageKey::Listings),
            market_fee_bps: DEFAULT_MARKET_FEE_BPS,
            treasury,
            species: UnorderedMap::new(StorageKey::Species),
            species_price: DEFAULT_SPECIES_PRICE,
            revenue_banked: 0,
            paused: false,
        };

        contract.seed_built_in_species();

        // DECISION 4: the shop is repriced in NEAR rather than retired. The v1
        // ids and names are kept so existing clients and explorers still make
        // sense; only the currency changes.
        for (item_id, name, price_near, time_extension, xp, shield, is_revival) in [
            (1u16, "Beef", 10u128, 3 * 3_600u64, 30u32, 0u32, false),
            (2, "Water", 5, 3 * 3_600, 10, 0, false),
            (3, "Shield", 20, 0, 0, 1, false),
            (4, "Holy Water", 50, 3 * 3_600, 0, 0, true),
        ] {
            contract.shop.insert(
                &item_id,
                &ShopItem {
                    item_id,
                    name: name.to_string(),
                    // Prices are in hundredths of a NEAR: Beef is 0.10 NEAR.
                    price: U128(price_near * 10u128.pow(22)),
                    time_extension,
                    xp,
                    shield,
                    is_revival,
                },
            );
            contract.shop_ids.push(item_id);
        }

        contract
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can call this"
        );
    }

    /// Remove a pet and its NEP-171 token everywhere either is recorded.
    fn burn_pet(&mut self, pet: &Pet) {
        let token_id: TokenId = pet.pet_id.to_string();
        self.pets.remove(&pet.pet_id);
        self.listings.remove(&pet.pet_id);

        self.tokens.owner_by_id.remove(&token_id);
        if let Some(by_id) = self.tokens.token_metadata_by_id.as_mut() {
            by_id.remove(&token_id);
        }
        if let Some(per_owner) = self.tokens.tokens_per_owner.as_mut() {
            if let Some(mut owned) = per_owner.get(&pet.owner_id) {
                owned.remove(&token_id);
                if owned.is_empty() {
                    per_owner.remove(&pet.owner_id);
                } else {
                    per_owner.insert(&pet.owner_id, &owned);
                }
            }
        }
        if let Some(approvals) = self.tokens.approvals_by_id.as_mut() {
            approvals.remove(&token_id);
        }
        if let Some(next) = self.tokens.next_approval_id_by_id.as_mut() {
            next.remove(&token_id);
        }

        NftBurn {
            owner_id: &pet.owner_id,
            token_ids: &[&token_id],
            authorized_id: None,
            memo: Some("species retired"),
        }
        .emit();
    }

    fn assert_running(&self) {
        require!(!self.paused, "The game is paused");
    }

    fn expect_pet(&self, pet_id: u64) -> Pet {
        self.pets.get(&pet_id).expect("No such pet")
    }

    fn assert_pet_owner(&self, pet: &Pet) {
        require!(
            pet.owner_id == env::predecessor_account_id(),
            "That pet belongs to someone else"
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

    /// A uniform value in `0..range`, from the block's random seed.
    ///
    /// Good enough for loot and a combat jitter. A validator can in principle
    /// influence it, so nothing of real value may hang on a single roll — the
    /// battle formula is therefore mostly deterministic, with randomness only
    /// as a tie-breaker band.
    fn roll(range: u32, salt: u8) -> u32 {
        let seed = env::random_seed();
        let a = *seed.first().unwrap_or(&0) as u32;
        let b = *seed.get(1).unwrap_or(&0) as u32;
        let c = *seed.get(2).unwrap_or(&0) as u32;
        (((a << 16) | (b << 8) | c) ^ salt as u32) % range.max(1)
    }

    /// NFT metadata for a pet, with the drawing passed in.
    ///
    /// `media` used to be built here as `/assets/animation/<category>/…`,
    /// a relative path that resolves only inside the desktop app: every
    /// wallet and every explorer showed a broken image. The species registry
    /// holds a real url, so the caller looks it up and hands it over.
    fn token_metadata(pet: &Pet, media: String) -> TokenMetadata {
        TokenMetadata {
            title: Some(pet.name.clone()),
            description: Some(format!(
                "A {:?} {} · level {} · {} stars",
                pet.rarity, pet.category, pet.level, pet.star
            )),
            media: Some(media),
            media_hash: None,
            copies: Some(1),
            issued_at: Some(pet.born_at.to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: None,
            reference: None,
            reference_hash: None,
        }
    }

    /// Tell the staking contract to re-weight a pet whose attributes changed.
    ///
    /// Only worth doing while the pet is at work; `sync_pet` panics otherwise.
    /// The promise is fire-and-forget: a failed sync leaves the old weight in
    /// place, which pays slightly wrong until the next change rather than
    /// breaking anything.
    fn sync_weight(&self, pet: &Pet) {
        if !pet.locked {
            return;
        }
        ext_stake::ext(self.stake_contract.clone())
            .with_static_gas(GAS_FOR_SYNC)
            .sync_pet(pet.pet_id)
            .detach();
    }

    // ── Minting ──────────────────────────────────────────────────────────────

    /// Put the two shipped species in the registry, owned by this contract.
    ///
    /// Idempotent: a species already there keeps its art and its mint count,
    /// so running this from `migrate` cannot overwrite a registry that is
    /// already correct.
    fn seed_built_in_species(&mut self) {
        let now = env::block_timestamp();
        for (id, name) in BUILT_IN_SPECIES {
            if self.species.get(&id.to_string()).is_some() {
                continue;
            }
            self.species.insert(
                &id.to_string(),
                &Species {
                    id: id.to_string(),
                    name: name.to_string(),
                    creator_id: env::current_account_id(),
                    art: (1..=ART_PHASES)
                        .map(|phase| format!("{BUILT_IN_ART_BASE}/{id}/{phase}.gif"))
                        .collect(),
                    created_at: U64(now),
                    minted: 0,
                },
            );
        }
    }

    /// The drawing a pet of this species wears at this phase.
    ///
    /// An empty string for a species that is somehow missing, rather than a
    /// panic: metadata is rewritten on evolve and on import, and a pet that
    /// cannot be drawn is far better than a pet that cannot evolve.
    fn art_for(&self, category: &str, phase: u8) -> String {
        self.species
            .get(&category.to_string())
            .map(|species| species.art_for(phase).to_string())
            .unwrap_or_default()
    }

    fn internal_mint(&mut self, owner_id: AccountId, name: String, category: String, salt: u8) -> u64 {
        let mut species = self
            .species
            .get(&category)
            .unwrap_or_else(|| env::panic_str("Unknown pet category"));

        let category_id = category.clone();
        let pet_id = self.next_pet_id;
        self.next_pet_id += 1;

        // DECISION 5: rarity is rolled at mint with published odds, so minting
        // another pet is a real decision rather than a formality. Odds live in
        // `Rarity::ODDS_BPS` and are readable through `get_mint_odds`.
        let rarity = Rarity::from_roll(Self::roll(10_000, salt));
        let (atk, def) = rarity.base_stats();
        let now = env::block_timestamp();

        let pet = Pet {
            pet_id,
            owner_id: owner_id.clone(),
            name: name.chars().take(32).collect(),
            category,
            rarity,
            level: 0,
            star: 0,
            xp: 0,
            evolution_phase: 1,
            atk,
            def,
            starves_at: now + STARVE_SECONDS * NANOS_PER_SECOND,
            born_at: now,
            last_attack_used: 0,
            last_attacked: 0,
            shield: 0,
            win_streak: 0,
            locked: false,
        };

        // The creator's only scoreboard, and the one number that says whether
        // a species anybody can add is a species anybody wanted.
        species.minted += 1;
        let media = species.art_for(pet.evolution_phase).to_string();
        self.species.insert(&category_id, &species);

        let token_id = pet_id.to_string();
        self.tokens.internal_mint_with_refund(
            token_id.clone(),
            owner_id.clone(),
            Some(Self::token_metadata(&pet, media)),
            // No refund: the deposit is the mint price and it stays here until
            // `sweep` moves it to the treasury. The standard's `internal_mint`
            // would hand the excess over storage back to the caller, which for
            // a 2 NEAR mint means handing back the mint price.
            None,
        );
        self.pets.insert(&pet_id, &pet);

        // Emitted by hand precisely because of the `None` above: the standard
        // emits `nft_mint` from `internal_mint`, the wrapper we cannot use, and
        // `internal_mint_with_refund` emits nothing at all.
        //
        // An explorer's token page still resolves without this, because it also
        // calls `nft_token` directly. What does not happen is indexing: the
        // contract never appears in an NFT index, a wallet's collectibles are
        // built from `nep171` events and stay empty, and nothing can show who
        // held a pet before. nearblocks returns an empty contract list for this
        // account while returning full metadata for contracts that emit.
        NftMint {
            owner_id: &owner_id,
            token_ids: &[&token_id],
            memo: None,
        }
        .emit();

        self.log_event(
            "pet_minted",
            json!({
                "pet_id": pet_id,
                "owner_id": owner_id,
                "rarity": pet.rarity,
                "category": pet.category,
            }),
        );

        pet_id
    }

    /// Mint for yourself.
    ///
    /// The whole deposit stays on the contract — mint price and NEP-171
    /// storage both — and `sweep` moves it to the treasury. Nothing is
    /// refunded, so a caller attaching more than the price is overpaying.
    #[payable]
    pub fn create_pet(&mut self, name: String, category: String) -> u64 {
        self.assert_running();
        let paid = env::attached_deposit().as_yoctonear();
        require!(paid >= self.mint_price, "Attach at least the mint price");
        self.paid_mint(env::predecessor_account_id(), name, category, paid, 1)
    }

    /// A mint someone paid for in NEAR: the creator's cut, then the rest banked.
    ///
    /// Both paying entry points come through here — a player's own
    /// `create_pet`, and the mint router's `create_pet_for` once it has turned
    /// a multichain payment back into NEAR — so a species' creator is paid the
    /// same 1% whichever way the pet was bought.
    fn paid_mint(
        &mut self,
        owner_id: AccountId,
        name: String,
        category: String,
        paid: u128,
        source: u8,
    ) -> u64 {
        let creator = self
            .species
            .get(&category)
            .map(|species| species.creator_id)
            .unwrap_or_else(|| env::panic_str("Unknown pet category"));

        // Nothing for the two this game shipped: their creator is this
        // contract, and paying yourself costs gas and moves no money.
        let royalty = if creator == env::current_account_id() {
            0
        } else {
            paid * CREATOR_ROYALTY_BPS / 10_000
        };

        // The rest of the deposit, not the price: nothing is refunded, so an
        // overpayment is revenue too and the treasury should see it.
        self.revenue_banked += paid - royalty;
        let pet_id = self.internal_mint(owner_id, name, category, source);

        if royalty > 0 {
            self.log_event(
                "royalty_paid",
                json!({
                    "pet_id": pet_id,
                    "creator_id": creator,
                    "amount": U128(royalty),
                }),
            );
            // No callback. A transfer to an account that no longer exists
            // fails and the NEAR stays here, which is the outcome a callback
            // would have had to arrange anyway.
            Promise::new(creator).transfer(NearToken::from_yoctonear(royalty)).detach();
        }

        pet_id
    }

    /// Mint for somebody else.
    ///
    /// Only the mint router may call this. A multichain payment arrives from a
    /// bridge rather than from the player's wallet, so the caller is never the
    /// owner and ownership has to be passed in.
    ///
    /// The router pays: it turns the wNEAR a bridge delivered back into NEAR
    /// and attaches the mint price, so the species' creator gets the same 1%
    /// as on a direct mint. Only the owner may mint without paying, for gifts.
    #[payable]
    pub fn create_pet_for(
        &mut self,
        owner_id: AccountId,
        name: String,
        category: String,
    ) -> u64 {
        self.assert_running();
        let caller = env::predecessor_account_id();
        require!(
            caller == self.mint_router || caller == self.owner_id,
            "Only the mint router can mint for another account"
        );
        let paid = env::attached_deposit().as_yoctonear();
        if caller == self.mint_router {
            require!(paid >= self.mint_price, "The router must attach the mint price");
        }
        if paid > 0 {
            self.paid_mint(owner_id, name, category, paid, 2)
        } else {
            self.internal_mint(owner_id, name, category, 2)
        }
    }

    // ── Species ──────────────────────────────────────────────────────────────

    /// Register a species anybody can then mint.
    ///
    /// Open to any account, for a fee. That is the point: a new animal used
    /// to need a contract deploy, because the list of species was a Rust
    /// constant, and a new desktop release, because the drawings were files
    /// in the app bundle. Both of those are a maintainer's privilege. This is
    /// a transaction.
    ///
    /// What the fee buys is a permanent, unique id. It is not refundable and
    /// the species cannot be deleted — pets of it would lose their drawings —
    /// so the price is the only thing standing between the registry and a
    /// thousand squatted names.
    ///
    /// The art is checked for shape, not for content. Nothing on chain can
    /// know whether a url serves a dragon, and a contract that pretended to
    /// would be lying; what it can do is refuse a url no client could draw.
    #[payable]
    pub fn create_species(&mut self, id: String, name: String, art: Vec<String>) -> String {
        self.assert_running();
        require!(
            env::attached_deposit().as_yoctonear() >= self.species_price,
            "Attach at least the species price"
        );

        if let Some(why) = species_id_error(&id) {
            env::panic_str(why);
        }
        require!(
            self.species.get(&id).is_none(),
            "That species id is taken"
        );
        let name: String = name.chars().take(MAX_SPECIES_NAME).collect();
        require!(!name.trim().is_empty(), "A species needs a name");
        require!(
            art.len() == ART_PHASES,
            "A species needs one drawing per evolution phase"
        );
        for uri in &art {
            if let Some(why) = art_uri_error(uri) {
                env::panic_str(why);
            }
        }

        let creator_id = env::predecessor_account_id();
        let created_at = env::block_timestamp();
        self.revenue_banked += env::attached_deposit().as_yoctonear();
        self.species.insert(
            &id,
            &Species {
                id: id.clone(),
                name: name.clone(),
                creator_id: creator_id.clone(),
                art,
                created_at: U64(created_at),
                minted: 0,
            },
        );

        self.log_event(
            "species_created",
            json!({
                "id": id,
                "name": name,
                "creator_id": creator_id,
                "paid": U128(env::attached_deposit().as_yoctonear()),
            }),
        );

        id
    }

    /// One species, or nothing.
    pub fn get_species(&self, id: String) -> Option<Species> {
        self.species.get(&id)
    }

    /// Every species, oldest first. The registry is small by design — a fee
    /// per entry and no deletions — so this needs no paging yet.
    pub fn list_species(&self) -> Vec<Species> {
        self.species.values().collect()
    }

    pub fn get_species_price(&self) -> U128 {
        U128(self.species_price)
    }

    /// Reprice the registry. Owner only.
    pub fn set_species_price(&mut self, price: U128) {
        self.assert_owner();
        self.species_price = price.0;
        self.log_event("species_price_set", json!({ "price": price }));
    }

    /// Withdraw a species, and burn every pet of it. Owner only.
    ///
    /// Registration says a species is never deleted, and for anybody else's
    /// species that stays true: this refuses unless every pet of the species
    /// is held by one of this game's own accounts (the owner, the contract,
    /// the mint router or the treasury). It exists for species the project
    /// registered itself, such as a worked example that outlived its use, and
    /// it cannot reach a pet a player owns.
    ///
    /// The built-in species are refused outright: the desktop app and every
    /// early pet assume they are there.
    ///
    /// Returns the ids of the pets it burned.
    pub fn retire_species(&mut self, id: String) -> Vec<u64> {
        self.assert_owner();
        require!(
            !BUILT_IN_SPECIES.iter().any(|(built_in, _)| *built_in == id),
            "A built-in species cannot be retired"
        );
        require!(self.species.get(&id).is_some(), "No species with that id");

        let house = [
            self.owner_id.clone(),
            env::current_account_id(),
            self.mint_router.clone(),
            self.treasury.clone(),
        ];
        let doomed: Vec<Pet> = self
            .pets
            .values()
            .filter(|pet| pet.category == id)
            .collect();
        for pet in &doomed {
            require!(
                house.contains(&pet.owner_id),
                "A pet of this species belongs to a player, so it cannot be retired"
            );
            require!(!pet.locked, "A pet of this species is at work; unstake it first");
        }

        for pet in &doomed {
            self.burn_pet(pet);
        }
        self.species.remove(&id);

        let burned: Vec<u64> = doomed.iter().map(|pet| pet.pet_id).collect();
        self.log_event("species_retired", json!({ "id": id, "burned": burned }));
        burned
    }

    // ── Care ─────────────────────────────────────────────────────────────────

    pub fn change_name_pet(&mut self, pet_id: u64, name: String) {
        let mut pet = self.expect_pet(pet_id);
        self.assert_pet_owner(&pet);
        pet.name = name.chars().take(32).collect();
        self.pets.insert(&pet_id, &pet);
    }

    /// Buy a shop item and apply it immediately.
    ///
    /// The attached deposit is the price. Feeding moves the starving deadline
    /// and may grant XP, which can level the pet — so this is also one of the
    /// places that has to re-sync staking weight.
    #[payable]
    pub fn buy_item(&mut self, pet_id: u64, item_id: u16) {
        self.assert_running();
        let item = self.shop.get(&item_id).expect("Unknown item");
        require!(
            env::attached_deposit().as_yoctonear() >= item.price.0,
            "Attach at least the item price"
        );

        let mut pet = self.expect_pet(pet_id);
        self.assert_pet_owner(&pet);

        let now = env::block_timestamp();
        if !pet.is_alive(now) {
            require!(item.is_revival, "This pet has starved — use a revival item");
        }

        // Banked food is capped, so a pet cannot be made immortal in one go.
        let from = pet.starves_at.max(now);
        let extended = from + item.time_extension * NANOS_PER_SECOND;
        let ceiling = now + MAX_STARVE_SECONDS * NANOS_PER_SECOND;
        pet.starves_at = extended.min(ceiling);
        pet.shield = pet.shield.saturating_add(item.shield);

        let levelled = self.grant_xp(&mut pet, item.xp);
        self.pets.insert(&pet_id, &pet);

        self.log_event(
            "item_used",
            json!({
                "pet_id": pet_id,
                "item_id": item_id,
                "paid": item.price,
                "levelled": levelled,
            }),
        );

        // Shields count towards staking weight, so a new one is a re-weigh too.
        if levelled || item.shield > 0 {
            self.sync_weight(&pet);
        }
    }

    /// Feed a pet on behalf of its owner, paid for in AI credits.
    ///
    /// Auto-feed (issue #8) debits the player's credit balance on `pet-stake`,
    /// but the starving deadline lives here — and every other way of moving it
    /// (`buy_item`) is `assert_pet_owner` plus an attached NEAR deposit, which a
    /// server key signing for an absent player cannot satisfy. So this is the
    /// one caller-gated feeding door, shaped exactly like `award_xp`: only the
    /// staking contract or this contract's owner may open it.
    ///
    /// `owner_id` is checked against the pet rather than trusted. `pet-stake`
    /// charges *that account's* credits, so if the two could disagree a
    /// compromised oracle could spend one player's balance on another player's
    /// pet. Returning `false` instead of panicking is deliberate: the caller
    /// refunds on a false, and a panic across a cross-contract boundary loses
    /// which of the two reasons it was.
    ///
    /// No XP. Auto-feed runs no inference, so there is no taste multiplier to
    /// grade the meal — it keeps the pet alive while the player is away rather
    /// than levelling it in their absence.
    pub fn feed_from_stake(&mut self, pet_id: u64, owner_id: AccountId) -> bool {
        require!(
            env::predecessor_account_id() == self.stake_contract
                || env::predecessor_account_id() == self.owner_id,
            "Only the staking contract can feed a pet for its owner"
        );

        let Some(mut pet) = self.pets.get(&pet_id) else {
            env::log_str("No such pet");
            return false;
        };
        if pet.owner_id != owner_id {
            env::log_str("That pet belongs to someone else");
            return false;
        }

        let now = env::block_timestamp();
        // Auto-feed keeps a pet alive; it does not resurrect one. Reviving is a
        // separate, deliberately expensive sink, and a player who has lost a pet
        // should be told rather than quietly charged for feeding a corpse.
        if !pet.is_alive(now) {
            env::log_str("This pet has starved — it needs a revival item");
            return false;
        }

        // Same banked-food ceiling as the shop, so auto-feed cannot stockpile
        // more life than a paying player can.
        let extended = pet.starves_at + AUTO_FEED_SECONDS * NANOS_PER_SECOND;
        let ceiling = now + MAX_STARVE_SECONDS * NANOS_PER_SECOND;
        pet.starves_at = extended.min(ceiling);
        self.pets.insert(&pet_id, &pet);

        self.log_event(
            "pet_auto_fed",
            json!({
                "pet_id": pet_id,
                "owner_id": owner_id,
                "seconds": AUTO_FEED_SECONDS,
                "starves_at": U64(pet.starves_at),
            }),
        );

        true
    }

    /// Bring a starved pet back, paid for in credits on the staking contract.
    ///
    /// Holy Water did this for NEAR and still can. This exists so that
    /// credits are the one currency a player needs: the item shop and the
    /// AI-credit balance were two ways to buy overlapping things, and the
    /// shop's prices are in a token nobody earns by playing.
    ///
    /// Same shape as `feed_from_stake` on purpose — caller-gated, and every
    /// refusal comes back as `false` rather than a panic so the staking
    /// contract can refund rather than lose the player's credits in a failed
    /// receipt.
    pub fn revive_from_stake(&mut self, pet_id: u64, owner_id: AccountId) -> bool {
        require!(
            env::predecessor_account_id() == self.stake_contract
                || env::predecessor_account_id() == self.owner_id,
            "Only the staking contract can revive a pet for its owner"
        );

        let Some(mut pet) = self.pets.get(&pet_id) else {
            env::log_str("No such pet");
            return false;
        };
        if pet.owner_id != owner_id {
            env::log_str("That pet belongs to someone else");
            return false;
        }

        let now = env::block_timestamp();
        // Reviving a living pet would charge for nothing. Feeding is the call
        // for that, and it is cheaper.
        if pet.is_alive(now) {
            env::log_str("This pet has not starved — feed it instead");
            return false;
        }

        pet.starves_at = now + REVIVE_SECONDS * NANOS_PER_SECOND;
        self.pets.insert(&pet_id, &pet);

        self.log_event(
            "pet_revived",
            json!({
                "pet_id": pet_id,
                "owner_id": owner_id,
                "seconds": REVIVE_SECONDS,
                "starves_at": U64(pet.starves_at),
            }),
        );

        true
    }

    /// Add XP and level up as far as it goes. Returns whether the level moved.
    fn grant_xp(&self, pet: &mut Pet, xp: u32) -> bool {
        if xp == 0 {
            return false;
        }
        pet.xp = pet.xp.saturating_add(xp);
        self.settle_level(pet)
    }

    /// Level up as far as the XP a pet already holds reaches.
    ///
    /// Normally only reached through `grant_xp`. It is separate because the
    /// level curve changed (100 × 1.18 to 60 × 1.12) under pets that had
    /// banked XP against the old one: RINGER held 81 XP at level 0 with 60
    /// needed, and only levelled once it next earned XP.
    fn settle_level(&self, pet: &mut Pet) -> bool {
        let before = pet.level;
        while pet.level < MAX_LEVEL {
            let need = pet.xp_for_next_level();
            if pet.xp < need {
                break;
            }
            pet.xp -= need;
            pet.level += 1;
            // Stats grow with level so combat keeps pace with weight.
            pet.atk += 4;
            pet.def += 3;
        }

        if pet.level != before {
            self.log_event(
                "pet_levelled",
                json!({ "pet_id": pet.pet_id, "level": pet.level }),
            );
        }
        pet.level != before
    }

    /// Grant XP from an off-chain action the staking contract charged for,
    /// such as an AI feed. Only that contract may call it.
    pub fn award_xp(&mut self, pet_id: u64, xp: u32) {
        require!(
            env::predecessor_account_id() == self.stake_contract
                || env::predecessor_account_id() == self.owner_id,
            "Only the staking contract can award XP"
        );
        let mut pet = self.expect_pet(pet_id);
        let levelled = self.grant_xp(&mut pet, xp.min(500));
        self.pets.insert(&pet_id, &pet);
        if levelled {
            self.sync_weight(&pet);
        }
    }

    /// Advance a pet to its next evolution phase. Raises staking weight, and
    /// therefore both income and drop rate, permanently.
    pub fn evolve(&mut self, pet_id: u64) {
        self.assert_running();
        let mut pet = self.expect_pet(pet_id);
        self.assert_pet_owner(&pet);
        require!(
            pet.evolution_phase < MAX_EVOLUTION_PHASE,
            "This pet is fully evolved"
        );
        require!(
            pet.level >= pet.evolution_phase as u32 * LEVELS_PER_PHASE,
            "Not enough levels to evolve yet"
        );

        pet.evolution_phase += 1;
        self.pets.insert(&pet_id, &pet);
        let media = self.art_for(&pet.category, pet.evolution_phase);
        self.tokens.token_metadata_by_id.as_mut().map(|by_id| {
            by_id.insert(&pet_id.to_string(), &Self::token_metadata(&pet, media))
        });

        self.log_event(
            "pet_evolved",
            json!({ "pet_id": pet_id, "phase": pet.evolution_phase }),
        );
        self.sync_weight(&pet);
    }

    /// Evolve a pet on behalf of its owner, paid for in credits.
    ///
    /// `evolve` itself takes no payment, and the staking contract has carried
    /// a 500,000 micro-credit price for it since the sinks were seeded — with
    /// nothing joining the two. So the most expensive action in the game
    /// charged half a credit and did nothing, which is the fault that retired
    /// the first revive sink and the one `feed` carried for months.
    ///
    /// Same shape as `feed_from_stake` and `revive_from_stake`: caller-gated,
    /// and every refusal is `false` rather than a panic so the staking
    /// contract refunds instead of losing the credits in a failed receipt.
    pub fn evolve_from_stake(&mut self, pet_id: u64, owner_id: AccountId) -> bool {
        require!(
            env::predecessor_account_id() == self.stake_contract
                || env::predecessor_account_id() == self.owner_id,
            "Only the staking contract can evolve a pet for its owner"
        );

        let Some(mut pet) = self.pets.get(&pet_id) else {
            env::log_str("No such pet");
            return false;
        };
        if pet.owner_id != owner_id {
            env::log_str("That pet belongs to someone else");
            return false;
        }
        if pet.evolution_phase >= MAX_EVOLUTION_PHASE {
            env::log_str("This pet is fully evolved");
            return false;
        }
        if pet.level < pet.evolution_phase as u32 * LEVELS_PER_PHASE {
            env::log_str("Not enough levels to evolve yet");
            return false;
        }

        pet.evolution_phase += 1;
        self.pets.insert(&pet_id, &pet);
        let media = self.art_for(&pet.category, pet.evolution_phase);
        self.tokens.token_metadata_by_id.as_mut().map(|by_id| {
            by_id.insert(&pet_id.to_string(), &Self::token_metadata(&pet, media))
        });

        self.log_event(
            "pet_evolved",
            json!({ "pet_id": pet_id, "phase": pet.evolution_phase, "owner_id": owner_id }),
        );
        // A phase is worth staking weight, so a pet at work has to be re-read.
        self.sync_weight(&pet);
        true
    }

    // ── Marketplace ──────────────────────────────────────────────────────────

    /// Offer a pet for sale, priced in NEAR.
    ///
    /// Listings live here rather than in a separate marketplace contract on
    /// purpose. This contract already owns transfers and the staking lock, so a
    /// sale is one atomic call — there is no window in which a pet gets staked
    /// between being listed and being bought, and no escrow hop to go wrong.
    #[payable]
    pub fn list_pet(&mut self, pet_id: u64, price: U128) {
        self.assert_running();
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "Attach 1 yoctoNEAR"
        );
        require!(price.0 > 0, "Set a price");

        let pet = self.expect_pet(pet_id);
        self.assert_pet_owner(&pet);
        require!(
            !pet.locked,
            "This pet is at work in the AI Lab — unstake it before selling"
        );

        self.listings.insert(
            &pet_id,
            &PetListing {
                pet_id,
                seller_id: pet.owner_id.clone(),
                price,
                listed_at: U64(env::block_timestamp()),
            },
        );

        self.log_event(
            "pet_listed",
            json!({ "pet_id": pet_id, "seller_id": pet.owner_id, "price": price }),
        );
    }

    #[payable]
    pub fn unlist_pet(&mut self, pet_id: u64) {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "Attach 1 yoctoNEAR"
        );
        let listing = self.listings.get(&pet_id).expect("That pet is not for sale");
        require!(
            listing.seller_id == env::predecessor_account_id(),
            "That listing is not yours"
        );
        self.internal_unlist(pet_id, "unlisted");
    }

    fn internal_unlist(&mut self, pet_id: u64, reason: &str) {
        if self.listings.remove(&pet_id).is_some() {
            self.log_event("pet_unlisted", json!({ "pet_id": pet_id, "reason": reason }));
        }
    }

    /// Buy a listed pet. The deposit must cover the price; change is returned.
    #[payable]
    pub fn buy_pet(&mut self, pet_id: u64) -> Promise {
        self.assert_running();

        let listing = self.listings.get(&pet_id).expect("That pet is not for sale");
        let buyer_id = env::predecessor_account_id();
        require!(listing.seller_id != buyer_id, "That listing is yours");

        let paid = env::attached_deposit().as_yoctonear();
        require!(paid >= listing.price.0, "Attach at least the asking price");

        let mut pet = self.expect_pet(pet_id);
        // A listing is only an offer by whoever owns the pet now. Every way a
        // pet moves should end its listing, but a sale pays the seller and is
        // irreversible, so check rather than trust that it did.
        let token_owner = self.tokens.owner_by_id.get(&pet_id.to_string());
        require!(
            pet.owner_id == listing.seller_id && token_owner.as_ref() == Some(&listing.seller_id),
            "That listing is stale: the pet has changed hands"
        );
        // Nothing should be able to lock a pet between listing and sale, but a
        // sale is irreversible, so check rather than assume.
        require!(!pet.locked, "This pet is at work in the AI Lab");

        let fee = listing.price.0 * self.market_fee_bps as u128 / 10_000;
        let to_seller = listing.price.0 - fee;
        let change = paid - listing.price.0;

        // Move the token and the game's own owner field together.
        //
        // `internal_transfer_unguarded` is the silent variant, like the mint
        // above: it skips the approval checks `buy_pet` has already done, and
        // skips the event with them. A sale that emits nothing leaves every
        // indexer believing the seller still owns the pet.
        let token_id = pet_id.to_string();
        self.tokens
            .internal_transfer_unguarded(&token_id, &listing.seller_id, &buyer_id);
        NftTransfer {
            old_owner_id: &listing.seller_id,
            new_owner_id: &buyer_id,
            token_ids: &[&token_id],
            authorized_id: None,
            memo: Some("sold on the JOYGOTCHI market"),
        }
        .emit();

        pet.owner_id = buyer_id.clone();
        self.pets.insert(&pet_id, &pet);
        self.listings.remove(&pet_id);

        self.log_event(
            "pet_sold",
            json!({
                "pet_id": pet_id,
                "seller_id": listing.seller_id,
                "buyer_id": buyer_id,
                "price": listing.price,
                "fee": U128(fee),
            }),
        );

        // The fee funds the treasury, which is what gets staked with NEAR AI —
        // so trading volume feeds the credit stream too.
        let mut payout = Promise::new(listing.seller_id.clone())
            .transfer(NearToken::from_yoctonear(to_seller));
        if fee > 0 {
            payout = payout
                .then(Promise::new(self.treasury.clone()).transfer(NearToken::from_yoctonear(fee)));
        }
        if change > 0 {
            payout =
                payout.then(Promise::new(buyer_id).transfer(NearToken::from_yoctonear(change)));
        }
        payout
    }

    pub fn get_pet_listing(&self, pet_id: u64) -> Option<PetListing> {
        self.listings.get(&pet_id)
    }

    pub fn get_pet_listings(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<PetListing> {
        self.listings
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .collect()
    }

    pub fn set_market_fee_bps(&mut self, fee_bps: u16) {
        self.assert_owner();
        require!(fee_bps <= 1_000, "Fee cannot exceed 10%");
        self.market_fee_bps = fee_bps;
    }

    pub fn set_treasury(&mut self, treasury: AccountId) {
        self.assert_owner();
        self.treasury = treasury;
    }

    // ── Battle ───────────────────────────────────────────────────────────────

    /// Attack another pet.
    ///
    /// DECISION 2: the winner is decided here, mostly deterministically. Each
    /// side's score is its effective attack against the other's effective
    /// defence, plus a ±15% band rolled from the block seed. A player can see
    /// why they lost — the scores go into the event — while the band stops the
    /// matchup being perfectly solvable in advance.
    ///
    /// The settlement call comes first and the damage is applied in the
    /// callback. The other order looks equivalent and is not: if
    /// `report_battle` reverts — which it does for any pet that is staked,
    /// warded or wounded — a protected pet would already have been hurt.
    pub fn attack(&mut self, pet_id: u64, target_pet_id: u64) -> Promise {
        self.assert_running();
        require!(pet_id != target_pet_id, "A pet cannot fight itself");

        let mine = self.expect_pet(pet_id);
        let target = self.expect_pet(target_pet_id);
        self.assert_pet_owner(&mine);
        require!(
            mine.owner_id != target.owner_id,
            "Both pets have the same owner"
        );

        let now = env::block_timestamp();
        require!(mine.is_alive(now), "Your pet has starved — feed it first");
        require!(target.is_alive(now), "That pet has already starved");

        /*
         * A pet at work in the lab may still fight.
         *
         * `locked` exists for one documented reason — DECISION 3, a staked
         * pet cannot be transferred or approved, because a sale has to be
         * atomic and a cross-contract view cannot be. Fighting moves no
         * ownership, so that reason does not reach it.
         *
         * Refusing a locked pet here made battle impossible rather than
         * restricted. Staking is the only way to earn credits, so every pet
         * worth fighting was at work, and the pool of legal opponents was
         * empty: of eight pets on this contract, one was both alive and
         * unlocked, and it needs an opponent with a different owner.
         *
         * The contract already disagreed with itself about this.
         * `sync_weight` re-reads a pet's staking weight after a battle
         * changes its level or star, and its first line returns unless the
         * pet is locked — machinery written for a staked pet winning a fight,
         * which this rule made unreachable.
         */

        require!(
            now.saturating_sub(mine.last_attack_used)
                >= ATTACK_COOLDOWN_SECONDS * NANOS_PER_SECOND
                || mine.last_attack_used == 0,
            "Your pet is still recovering from its last attack"
        );
        require!(
            now.saturating_sub(target.last_attacked)
                >= ATTACKED_COOLDOWN_SECONDS * NANOS_PER_SECOND
                || target.last_attacked == 0,
            "That pet was attacked too recently"
        );

        let (attacker_score, defender_score) = Self::battle_scores(&mine, &target);
        let attacker_wins = attacker_score >= defender_score;

        let (winner_pet_id, winner_id, loser_pet_id, loser_id) = if attacker_wins {
            (pet_id, mine.owner_id.clone(), target_pet_id, target.owner_id.clone())
        } else {
            (target_pet_id, target.owner_id.clone(), pet_id, mine.owner_id.clone())
        };

        self.log_event(
            "battle_rolled",
            json!({
                "pet_id": pet_id,
                "target_pet_id": target_pet_id,
                "attacker_score": U64(attacker_score),
                "defender_score": U64(defender_score),
                "winner_pet_id": winner_pet_id,
            }),
        );

        ext_stake::ext(self.stake_contract.clone())
            .with_static_gas(GAS_FOR_BATTLE)
            .report_battle(winner_pet_id, winner_id, loser_pet_id, loser_id)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_BATTLE_RESOLVE)
                    .on_battle_settled(winner_pet_id, loser_pet_id),
            )
    }

    /// Both sides' scores, with the random band applied.
    fn battle_scores(attacker: &Pet, defender: &Pet) -> (u64, u64) {
        let band = 30; // ±15%
        let attacker_roll = 85 + Self::roll(band + 1, 3) as u64;
        let defender_roll = 85 + Self::roll(band + 1, 5) as u64;

        let attacker_score = attacker.effective_atk() * attacker_roll / 100;
        let defender_score = defender.effective_def() * defender_roll / 100;
        (attacker_score, defender_score)
    }

    /// Apply the consequences once the credits have actually moved.
    #[private]
    pub fn on_battle_settled(
        &mut self,
        winner_pet_id: u64,
        loser_pet_id: u64,
        #[callback_result] result: Result<BattleOutcome, PromiseError>,
    ) -> bool {
        let Ok(outcome) = result else {
            // The settlement reverted — most often because the target turned
            // out to be protected. Nothing has been damaged, which is the
            // whole reason this runs after the call rather than before it.
            self.log_event(
                "battle_rejected",
                json!({ "winner_pet_id": winner_pet_id, "loser_pet_id": loser_pet_id }),
            );
            return false;
        };

        let now = env::block_timestamp();

        if let Some(mut winner) = self.pets.get(&winner_pet_id) {
            winner.last_attack_used = now;
            let levelled = self.grant_xp(&mut winner, 25);

            // Stars are earned here and nowhere else. Three wins in a row is
            // one star, and a single defeat takes it back — so the ladder is
            // worth climbing and worth defending.
            let mut starred = false;
            if winner.star < MAX_STAR {
                winner.win_streak += 1;
                if winner.win_streak >= WINS_PER_STAR {
                    winner.win_streak = 0;
                    winner.star += 1;
                    starred = true;
                    self.log_event(
                        "star_earned",
                        json!({ "pet_id": winner_pet_id, "star": winner.star }),
                    );
                }
            }

            self.pets.insert(&winner_pet_id, &winner);
            // A star is +15% staking weight, so it has to be re-read there.
            if levelled || starred {
                self.sync_weight(&winner);
            }
        }

        if let Some(mut loser) = self.pets.get(&loser_pet_id) {
            loser.last_attacked = now;
            // Any progress towards the next star is lost with the fight.
            loser.win_streak = 0;

            if loser.shield > 0 {
                // A Shield absorbs the hit itself, before anything else.
                loser.shield -= 1;
            } else if !outcome.star_protected && loser.star > 0 {
                loser.star -= 1;
            }

            // Losing costs time on the clock, not the pet's life. Pets never
            // die from a fight — see docs/ECONOMY.md.
            let penalty = 3 * 3_600 * NANOS_PER_SECOND;
            loser.starves_at = loser.starves_at.saturating_sub(penalty).max(now);

            self.pets.insert(&loser_pet_id, &loser);
            self.sync_weight(&loser);
        }

        self.log_event(
            "battle_settled",
            json!({
                "winner_pet_id": winner_pet_id,
                "loser_pet_id": loser_pet_id,
                "transferred": outcome.transferred,
                "star_protected": outcome.star_protected,
            }),
        );

        true
    }

    // ── Staking lock ─────────────────────────────────────────────────────────

    /// Mark a pet as at work, or back home.
    ///
    /// DECISION 3: a locked pet cannot be transferred or approved. The flag is
    /// mirrored here rather than read from `pet-stake`, because a transfer has
    /// to be atomic and a cross-contract view cannot be. `pet-stake` is the
    /// only account allowed to set it.
    pub fn set_locked(&mut self, pet_id: u64, locked: bool) {
        require!(
            env::predecessor_account_id() == self.stake_contract
                || env::predecessor_account_id() == self.owner_id,
            "Only the staking contract can lock a pet"
        );
        let mut pet = self.expect_pet(pet_id);
        pet.locked = locked;
        self.pets.insert(&pet_id, &pet);

        // A pet that goes to work stops being for sale. Leaving the listing up
        // would sell a buyer something they cannot use or move.
        if locked {
            self.internal_unlist(pet_id, "staked");
        }

        self.log_event("pet_lock_changed", json!({ "pet_id": pet_id, "locked": locked }));
    }

    fn assert_transferable(&self, token_id: &TokenId) {
        let pet_id: u64 = token_id.parse().expect("Bad token id");
        let pet = self.expect_pet(pet_id);
        require!(
            !pet.locked,
            "This pet is at work in the AI Lab — unstake it before transferring"
        );
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// Owner and the attributes staking weight is built from.
    ///
    /// `pet-stake` calls this with 10 TGas from `stake_pet` and `sync_pet`,
    /// and refuses the stake when the owner does not match the caller.
    pub fn get_pet_attrs(&self, pet_id: u64) -> (AccountId, PetAttrs) {
        let pet = self.expect_pet(pet_id);
        let attrs = pet.attrs();
        (pet.owner_id, attrs)
    }

    /// `get_pet_attrs` plus the pet's shields, which count towards staking
    /// weight.
    ///
    /// A separate view rather than a field on `PetAttrs`: the staking
    /// contract stores `PetAttrs` inside every staked record, and growing it
    /// is what broke every one of them the first time this was tried. The
    /// shield count travels alongside instead, and only the weight it
    /// produces is stored.
    pub fn get_pet_stake_attrs(&self, pet_id: u64) -> (AccountId, PetAttrs, u32) {
        let pet = self.expect_pet(pet_id);
        (pet.owner_id.clone(), pet.attrs(), pet.shield)
    }

    pub fn get_pet(&self, pet_id: u64) -> Option<PetView> {
        self.pets.get(&pet_id).map(|pet| self.to_view(&pet))
    }

    fn to_view(&self, pet: &Pet) -> PetView {
        let now = env::block_timestamp();
        PetView {
            pet_id: pet.pet_id,
            owner_id: pet.owner_id.clone(),
            name: pet.name.clone(),
            category: pet.category.clone(),
            rarity: pet.rarity,
            level: pet.level,
            star: pet.star,
            xp: pet.xp,
            xp_for_next_level: pet.xp_for_next_level(),
            evolution_phase: pet.evolution_phase,
            atk: pet.atk,
            def: pet.def,
            effective_atk: U64(pet.effective_atk()),
            effective_def: U64(pet.effective_def()),
            starves_at: U64(pet.starves_at),
            seconds_until_starving: U64(pet.starves_at.saturating_sub(now) / NANOS_PER_SECOND),
            status: pet.status(now),
            shield: pet.shield,
            listed_price: self.listings.get(&pet.pet_id).map(|l| l.price),
            win_streak: pet.win_streak,
            wins_to_next_star: if pet.star >= MAX_STAR {
                None
            } else {
                Some(WINS_PER_STAR - pet.win_streak)
            },
            locked: pet.locked,
            born_at: U64(pet.born_at),
            last_attack_used: U64(pet.last_attack_used),
            last_attacked: U64(pet.last_attacked),
        }
    }

    /// Every pet. Kept for compatibility with the v1 client, which reads the
    /// whole set and filters locally.
    pub fn get_all_pet_metadata(&self) -> Vec<PetView> {
        self.pets.values().map(|pet| self.to_view(&pet)).collect()
    }

    /// Every pet, a page at a time.
    ///
    /// Without this the desktop window read the population by walking token
    /// ids — one `get_pet` per pet, every twelve seconds, to find out whether
    /// anyone had attacked you. Eight pets made that nine calls and the free
    /// RPC tiers answer about eight before returning 429, so the app spent
    /// the day rate-limiting itself and showing the result as a broken
    /// contract. A hundred pets would have made it a hundred and one.
    ///
    /// `limit` is capped rather than trusted: this iterates, and a caller
    /// asking for everything on a large contract would run out of gas inside
    /// a view.
    pub fn get_pets(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<PetView> {
        let skip = from_index.unwrap_or(0) as usize;
        let take = limit.unwrap_or(50).min(100) as usize;
        self.pets
            .values()
            .skip(skip)
            .take(take)
            .map(|pet| self.to_view(&pet))
            .collect()
    }

    pub fn get_pets_for_owner(&self, account_id: AccountId) -> Vec<PetView> {
        self.pets
            .values()
            .filter(|pet| pet.owner_id == account_id)
            .map(|pet| self.to_view(&pet))
            .collect()
    }

    pub fn is_pet_alive(&self, pet_id: u64) -> bool {
        self.pets
            .get(&pet_id)
            .map(|pet| pet.is_alive(env::block_timestamp()))
            .unwrap_or(false)
    }

    pub fn get_shop(&self) -> Vec<ShopItem> {
        self.shop_ids
            .iter()
            .filter_map(|id| self.shop.get(id))
            .collect()
    }

    /// Published mint odds, in basis points.
    pub fn get_mint_odds(&self) -> Vec<(Rarity, u32)> {
        Rarity::ODDS_BPS.to_vec()
    }

    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        json!({
            "owner_id": self.owner_id,
            "stake_contract": self.stake_contract,
            "mint_router": self.mint_router,
            "mint_price": U128(self.mint_price),
            "market_fee_bps": self.market_fee_bps,
            "treasury": self.treasury,
            // Every species in the registry, not a constant: a client that
            // built its mint form from this used to go stale the moment
            // somebody added an animal.
            "categories": self.species.keys().collect::<Vec<String>>(),
            "species_price": U128(self.species_price),
            "total_species": self.species.len(),
            "total_pets": self.pets.len(),
            "paused": self.paused,
        })
    }

    // ── Upgrade ──────────────────────────────────────────────────────────────

    /// Read the state the previous code wrote, and add the species registry.
    ///
    /// This deploy adds two fields to the contract struct, which is a Borsh
    /// layout change: the new code cannot read what the old code wrote, and a
    /// `without-init-call` deploy would take the contract down with
    /// `Cannot deserialize the contract state`. This project has lost two
    /// deployments to exactly that, which is why the old layout is spelled
    /// out below rather than assumed.
    ///
    /// Nothing inside `pets` is touched. `Pet` is unchanged, so every stored
    /// record is read by the same code that wrote it, and `category` carries
    /// over as the key into the registry the seeding below fills.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        /// The contract struct as the deployed code wrote it: this struct,
        /// without `species` and `species_price`. Field order is the layout,
        /// so it must match the old source exactly, top to bottom.
        #[derive(BorshDeserialize)]
        #[borsh(crate = "near_sdk::borsh")]
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

        let old: OldGame = env::state_read().unwrap_or_else(|| {
            env::panic_str("No state to migrate — this is not an upgrade")
        });

        let mut contract = Self {
            tokens: old.tokens,
            metadata: old.metadata,
            owner_id: old.owner_id,
            stake_contract: old.stake_contract,
            mint_router: old.mint_router,
            pets: old.pets,
            next_pet_id: old.next_pet_id,
            shop: old.shop,
            shop_ids: old.shop_ids,
            mint_price: old.mint_price,
            listings: old.listings,
            market_fee_bps: old.market_fee_bps,
            treasury: old.treasury,
            species: UnorderedMap::new(StorageKey::Species),
            species_price: DEFAULT_SPECIES_PRICE,
            // Starts at zero, not at the balance. What is on this account
            // today is mint revenue *and* the storage staking for twenty
            // tokens, and nothing on chain can tell them apart after the
            // fact. Everything charged from here on is counted.
            revenue_banked: 0,
            paused: old.paused,
        };
        contract.seed_built_in_species();
        contract
    }

    /// Rewrite the stored NFT metadata for a run of pets.
    ///
    /// Pets minted before the registry carry `media` as a relative path, so
    /// every wallet and explorer draws them broken. Rewriting them is not
    /// part of `migrate` on purpose: a migration that loops over every pet
    /// has a pet count at which it runs out of gas, and finding that out
    /// during an upgrade is the worst time to find it out.
    ///
    /// Owner only, resumable, and safe to run twice.
    /// Level up every pet holding enough XP for it. Owner only, resumable.
    ///
    /// Walks pet ids from `from_pet_id`, at most `limit` of them, and returns
    /// the ids that moved. Safe to repeat: a pet already at the right level is
    /// left alone.
    pub fn settle_levels(&mut self, from_pet_id: u64, limit: u32) -> Vec<u64> {
        self.assert_owner();
        let mut moved = Vec::new();
        let mut pet_id = from_pet_id.max(1);
        let end = pet_id.saturating_add(limit as u64).min(self.next_pet_id);
        while pet_id < end {
            if let Some(mut pet) = self.pets.get(&pet_id) {
                if self.settle_level(&mut pet) {
                    self.pets.insert(&pet_id, &pet);
                    self.sync_weight(&pet);
                    moved.push(pet_id);
                }
            }
            pet_id += 1;
        }
        moved
    }

    pub fn refresh_metadata(&mut self, from_pet_id: u64, limit: u32) -> u64 {
        self.assert_owner();
        let mut touched = 0u64;
        let mut pet_id = from_pet_id.max(1);
        while touched < limit as u64 && pet_id < self.next_pet_id {
            if let Some(pet) = self.pets.get(&pet_id) {
                let media = self.art_for(&pet.category, pet.evolution_phase);
                if !media.is_empty() {
                    self.tokens.token_metadata_by_id.as_mut().map(|by_id| {
                        by_id.insert(&pet_id.to_string(), &Self::token_metadata(&pet, media))
                    });
                }
                touched += 1;
            }
            pet_id += 1;
        }
        // Where to start the next call.
        pet_id
    }

    // ── Owner ────────────────────────────────────────────────────────────────

    pub fn set_mint_price(&mut self, mint_price: U128) {
        self.assert_owner();
        self.mint_price = mint_price.0;
    }

    pub fn set_stake_contract(&mut self, stake_contract: AccountId) {
        self.assert_owner();
        self.stake_contract = stake_contract;
    }

    pub fn set_mint_router(&mut self, mint_router: AccountId) {
        self.assert_owner();
        self.mint_router = mint_router;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    pub fn set_shop_item(&mut self, item: ShopItem) {
        self.assert_owner();
        if !self.shop_ids.contains(&item.item_id) {
            self.shop_ids.push(item.item_id);
        }
        self.shop.insert(&item.item_id, &item);
    }

    /// Send everything taken for pets and species to the treasury.
    ///
    /// This is the first step of the loop the staking contract describes:
    /// mint revenue reaches the treasury, the treasury stakes it with NEAR
    /// AI, and the compute allowance that comes back is what
    /// `pet-stake::fund_epoch_from_reserve` streams to staked pets. Only
    /// that first step can happen on chain, so this is the step that is
    /// made automatic and countable rather than a number typed by hand.
    ///
    /// It sends the counter, never the balance. This account also holds the
    /// NEP-171 storage staking for every token ever minted, and a sweep of
    /// the balance would take the contract below its own storage cost —
    /// which is unrecoverable without sending NEAR back.
    ///
    /// Anyone may call it. There is one destination, it is set by the owner,
    /// and a sweep nobody can trigger is a sweep that stops happening.
    pub fn sweep_revenue(&mut self) -> Promise {
        let amount = self.revenue_banked;
        require!(amount > 0, "Nothing banked to sweep");
        self.revenue_banked = 0;

        self.log_event(
            "revenue_swept",
            json!({ "treasury": self.treasury, "amount": U128(amount) }),
        );
        Promise::new(self.treasury.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    /// What `sweep_revenue` would send.
    pub fn get_revenue_banked(&self) -> U128 {
        U128(self.revenue_banked)
    }

    /// Move NEAR off this contract by hand.
    ///
    /// The escape hatch, kept for the balance that predates the counter and
    /// for shop revenue. `sweep_revenue` is the one to use: this one trusts
    /// the caller to know what part of the balance is not storage staking.
    pub fn sweep(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        Promise::new(receiver_id).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Import pets from the v1 contract. All 20 of them fit in one call.
    ///
    /// `pet_id` is preserved so existing links and any `pet-stake` records stay
    /// valid, and `time_until_starving` is read for what it is — an absolute
    /// timestamp — rather than for what its name suggests.
    pub fn import_pets(&mut self, pets: Vec<LegacyPet>) -> u64 {
        self.assert_owner();
        let mut imported = 0;
        let mut minted: Vec<(AccountId, String)> = Vec::new();

        for legacy in pets {
            if self.pets.get(&legacy.pet_id).is_some() {
                continue;
            }

            // Every v1 pet is level 1 with no stars, so they are all common.
            let rarity = Rarity::Common;
            let (atk, def) = rarity.base_stats();

            let pet = Pet {
                pet_id: legacy.pet_id,
                owner_id: legacy.owner_id.clone(),
                name: legacy.name.chars().take(32).collect(),
                category: legacy.category.clone(),
                rarity,
                level: legacy.level.saturating_sub(1).min(MAX_LEVEL),
                star: legacy.star.min(MAX_STAR),
                xp: 0,
                evolution_phase: legacy.pet_evolution_phase.clamp(1, MAX_EVOLUTION_PHASE),
                atk,
                def,
                starves_at: legacy.time_until_starving.0,
                born_at: legacy.time_pet_born.0,
                last_attack_used: 0,
                last_attacked: 0,
                shield: 0,
                win_streak: 0,
                locked: false,
            };

            let media = self.art_for(&pet.category, pet.evolution_phase);
            self.tokens.internal_mint_with_refund(
                pet.pet_id.to_string(),
                pet.owner_id.clone(),
                Some(Self::token_metadata(&pet, media)),
                None,
            );
            // Silent imports would be the worst version of this bug: the twenty
            // pets carried over from v1 would arrive on mainnet already
            // invisible, and there is no second chance to emit a mint for a
            // token that already exists.
            minted.push((pet.owner_id.clone(), pet.pet_id.to_string()));

            self.pets.insert(&pet.pet_id, &pet);
            self.next_pet_id = self.next_pet_id.max(pet.pet_id + 1);
            imported += 1;
        }

        for (owner_id, token_id) in &minted {
            NftMint {
                owner_id,
                token_ids: &[token_id],
                memo: Some("imported from JOYGOTCHI v1"),
            }
            .emit();
        }

        self.log_event("pets_imported", json!({ "count": imported }));
        imported
    }
}

// ── NEP-171 ──────────────────────────────────────────────────────────────────

#[near]
impl Game {
    /// Transfers go through the standard, behind the lock check.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        self.assert_transferable(&token_id);
        let pet_id: u64 = token_id.parse().expect("Bad token id");

        near_contract_standards::non_fungible_token::core::NonFungibleTokenCore::nft_transfer(
            &mut self.tokens,
            receiver_id.clone(),
            token_id,
            approval_id,
            memo,
        );

        // Keep the game's own owner field in step with the standard's.
        if let Some(mut pet) = self.pets.get(&pet_id) {
            pet.owner_id = receiver_id;
            self.pets.insert(&pet_id, &pet);
        }
        // Moving a pet out of band ends any sale of it.
        self.internal_unlist(pet_id, "transferred");
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
        self.assert_transferable(&token_id);
        // Like `nft_transfer`, moving the pet ends any sale of it. Without
        // this the old listing outlived the move, and `buy_pet` would take
        // the pet from its new owner and pay the old one.
        let pet_id: u64 = token_id.parse().expect("Bad token id");
        self.internal_unlist(pet_id, "transferred");
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
    #[allow(clippy::too_many_arguments)]
    pub fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<std::collections::HashMap<AccountId, u64>>,
    ) -> bool {
        use near_contract_standards::non_fungible_token::core::NonFungibleTokenResolver;
        let kept = self.tokens.nft_resolve_transfer(
            previous_owner_id.clone(),
            receiver_id.clone(),
            token_id.clone(),
            approved_account_ids,
        );

        // `kept == true` means the receiver kept it; otherwise it came back.
        if let Ok(pet_id) = token_id.parse::<u64>() {
            if let Some(mut pet) = self.pets.get(&pet_id) {
                pet.owner_id = if kept { receiver_id } else { previous_owner_id };
                self.pets.insert(&pet_id, &pet);
            }
        }
        kept
    }

    #[payable]
    pub fn nft_approve(
        &mut self,
        token_id: TokenId,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
        self.assert_transferable(&token_id);
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
impl NonFungibleTokenMetadataProvider for Game {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_staking_contract_may_feed_on_an_owners_behalf() {
        // This is the door a session key reaches feeding through, so who may
        // open it is the whole of its safety.
        let mut contract = deploy();
        let id = mint(&mut contract, alice(), 0);

        testing_env!(ctx(bob(), 10, 0).build());
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.feed_from_stake(id, alice())
        }));
        assert!(refused.is_err(), "anyone could feed anyone's pet");
    }

    #[test]
    fn feeding_through_the_lab_moves_the_clock_and_checks_the_owner() {
        let mut contract = deploy();
        let id = mint(&mut contract, alice(), 0);

        testing_env!(ctx(stake(), 10, 0).build());
        let before = contract.get_pet(id).unwrap().starves_at.0;

        // Somebody else's pet: refused without panicking, because the caller
        // refunds on a false and a panic across contracts loses the reason.
        assert!(!contract.feed_from_stake(id, bob()));
        assert_eq!(contract.get_pet(id).unwrap().starves_at.0, before);

        assert!(contract.feed_from_stake(id, alice()));
        let after = contract.get_pet(id).unwrap().starves_at.0;
        assert_eq!(after - before, AUTO_FEED_SECONDS * NANOS_PER_SECOND);
    }

    #[test]
    fn get_pets_pages_and_caps_what_it_returns() {
        let mut contract = deploy();
        for _ in 0..5 {
            mint(&mut contract, alice(), 0);
        }

        assert_eq!(contract.get_pets(None, None).len(), 5);
        assert_eq!(contract.get_pets(None, Some(2)).len(), 2);
        assert_eq!(contract.get_pets(Some(3), Some(10)).len(), 2);
        assert_eq!(contract.get_pets(Some(99), None).len(), 0);

        // Asked for everything on a contract that iterates: capped, because
        // a view that runs out of gas is a view that answers nothing.
        assert_eq!(contract.get_pets(None, Some(u64::MAX)).len(), 5);
    }

    #[test]
    fn a_page_says_the_same_as_reading_each_pet() {
        let mut contract = deploy();
        let ids: Vec<u64> = (0..3).map(|_| mint(&mut contract, alice(), 0)).collect();

        let page = contract.get_pets(None, None);
        for id in ids {
            let one = contract.get_pet(id).unwrap();
            let from_page = page.iter().find(|p| p.pet_id == id).unwrap();
            assert_eq!(from_page.name, one.name);
            assert_eq!(from_page.seconds_until_starving, one.seconds_until_starving);
            assert_eq!(from_page.locked, one.locked);
        }
    }

    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const ONE_NEAR: u128 = 10u128.pow(24);

    fn owner() -> AccountId {
        "owner.near".parse().unwrap()
    }
    fn stake() -> AccountId {
        "stake.near".parse().unwrap()
    }
    fn router() -> AccountId {
        "mint.near".parse().unwrap()
    }
    fn alice() -> AccountId {
        "alice.near".parse().unwrap()
    }
    fn bob() -> AccountId {
        "bob.near".parse().unwrap()
    }

    fn ctx(predecessor: AccountId, seconds: u64, deposit: u128) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("game.near".parse().unwrap())
            .predecessor_account_id(predecessor)
            .block_timestamp(seconds * NANOS_PER_SECOND)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .random_seed([7u8; 32]);
        builder
    }

    fn treasury() -> AccountId {
        "treasury.near".parse().unwrap()
    }

    fn deploy() -> Game {
        testing_env!(ctx(owner(), 0, 0).build());
        Game::new(owner(), stake(), router(), treasury(), U128(2 * ONE_NEAR))
    }

    /// Mint a pet for `who` without going through the payable entry point.
    fn mint(contract: &mut Game, who: AccountId, at: u64) -> u64 {
        testing_env!(ctx(owner(), at, 0).build());
        contract.create_pet_for(who, "SMAUG".to_string(), "blackdragon".to_string())
    }

    // ── Species ──────────────────────────────────────────────────────────────

    fn art(id: &str) -> Vec<String> {
        (1..=ART_PHASES)
            .map(|phase| format!("https://art.example/{id}/{phase}.gif"))
            .collect()
    }

    /// Register a species as `who`, paying the asking price.
    fn add_species(contract: &mut Game, who: AccountId, id: &str) {
        let price = contract.get_species_price().0;
        testing_env!(ctx(who, 0, price).build());
        contract.create_species(id.to_string(), "Test Beast".to_string(), art(id));
    }

    #[test]
    fn a_species_anybody_registered_can_be_minted() {
        /*
         * The whole point of the registry. Before it, the species list was a
         * Rust constant, so this pet needed a contract deploy to exist and a
         * desktop release to be drawn. Both are a maintainer's privilege.
         */
        let mut contract = deploy();
        add_species(&mut contract, alice(), "coolbeast");

        testing_env!(ctx(owner(), 0, 0).build());
        let pet_id = contract.create_pet_for(
            bob(),
            "NEWT".to_string(),
            "coolbeast".to_string(),
        );

        let pet = contract.get_pet(pet_id).unwrap();
        assert_eq!(pet.category, "coolbeast");
    }

    #[test]
    fn the_built_in_species_are_there_from_the_first_block() {
        // Pets minted before the registry existed carry these ids. If seeding
        // ever stopped happening, every one of them would become unmintable
        // and unevolvable at once.
        let contract = deploy();
        for (id, _) in BUILT_IN_SPECIES {
            let species = contract.get_species(id.to_string()).expect("seeded");
            assert_eq!(species.art.len(), ART_PHASES);
            for uri in &species.art {
                assert!(uri.starts_with("https://"), "{uri} is not fetchable");
            }
        }
        assert_eq!(contract.list_species().len(), BUILT_IN_SPECIES.len());
    }

    #[test]
    fn seeding_twice_keeps_the_art_and_the_count() {
        // `migrate` calls this on a contract that may already hold the two,
        // and an overwrite there would reset every creator's mint count.
        let mut contract = deploy();
        mint(&mut contract, alice(), 0);
        let before = contract.get_species("blackdragon".to_string()).unwrap();
        assert_eq!(before.minted, 1);

        contract.seed_built_in_species();

        let after = contract.get_species("blackdragon".to_string()).unwrap();
        assert_eq!(after.minted, 1, "seeding reset a creator's count");
        assert_eq!(after.art, before.art);
    }

    #[test]
    fn metadata_carries_a_url_a_wallet_can_fetch() {
        /*
         * `media` used to be `/assets/animation/<category>/<phase>.gif`. A
         * relative path resolves against whatever origin is asking, so it
         * worked in the desktop app and nowhere else: every wallet and every
         * explorer drew these pets as a broken image.
         */
        let mut contract = deploy();
        add_species(&mut contract, alice(), "coolbeast");

        testing_env!(ctx(owner(), 0, 0).build());
        let pet_id =
            contract.create_pet_for(alice(), "NEWT".to_string(), "coolbeast".to_string());

        let token = contract.nft_token(pet_id.to_string()).unwrap();
        let media = token.metadata.unwrap().media.unwrap();
        assert_eq!(media, "https://art.example/coolbeast/1.gif");
    }

    #[test]
    fn evolving_moves_the_drawing_on() {
        let mut contract = deploy();
        add_species(&mut contract, alice(), "coolbeast");
        testing_env!(ctx(owner(), 0, 0).build());
        let pet_id =
            contract.create_pet_for(alice(), "NEWT".to_string(), "coolbeast".to_string());

        testing_env!(ctx(stake(), 0, 0).build());
        contract.award_xp(pet_id, 500);
        contract.award_xp(pet_id, 500);

        testing_env!(ctx(alice(), 0, 0).build());
        contract.evolve(pet_id);

        let token = contract.nft_token(pet_id.to_string()).unwrap();
        let media = token.metadata.unwrap().media.unwrap();
        assert_eq!(media, "https://art.example/coolbeast/2.gif");
    }

    #[test]
    fn the_last_drawing_covers_the_phase_that_has_none() {
        // The contract evolves to phase 4; art is drawn for three. Falling
        // back beats a broken image, and the app's `artPath` does the same.
        let species = Species {
            id: "x".to_string(),
            name: "X".to_string(),
            creator_id: alice(),
            art: art("x"),
            created_at: U64(0),
            minted: 0,
        };
        assert_eq!(species.art_for(4), species.art_for(3));
        assert_eq!(species.art_for(0), species.art_for(1));
    }

    #[test]
    fn minting_counts_against_the_species() {
        let mut contract = deploy();
        add_species(&mut contract, alice(), "coolbeast");
        testing_env!(ctx(owner(), 0, 0).build());
        for _ in 0..3 {
            contract.create_pet_for(bob(), "N".to_string(), "coolbeast".to_string());
        }
        assert_eq!(
            contract.get_species("coolbeast".to_string()).unwrap().minted,
            3
        );
    }

    #[test]
    #[should_panic(expected = "That species id is taken")]
    fn an_id_cannot_be_registered_twice() {
        // Ids are permanent and pets key off them, so a second registration
        // would silently repaint somebody else's animals.
        let mut contract = deploy();
        add_species(&mut contract, alice(), "coolbeast");
        add_species(&mut contract, bob(), "coolbeast");
    }

    #[test]
    #[should_panic(expected = "That species id is taken")]
    fn a_built_in_cannot_be_hijacked() {
        let mut contract = deploy();
        add_species(&mut contract, alice(), "blackdragon");
    }

    #[test]
    #[should_panic(expected = "Attach at least the species price")]
    fn registering_for_free_is_refused() {
        let mut contract = deploy();
        testing_env!(ctx(alice(), 0, 0).build());
        contract.create_species("coolbeast".to_string(), "Beast".to_string(), art("c"));
    }

    #[test]
    fn an_id_has_to_survive_a_url_and_a_file_path() {
        /*
         * A species id becomes a folder name under `~/.joygotchi`, a segment
         * in a url, and a string the desktop app switches on. Anything that
         * is awkward in all three is refused here rather than three layers
         * later.
         */
        assert!(species_id_error("coolbeast").is_none());
        assert!(species_id_error("beast2").is_none());

        assert!(species_id_error("ab").is_some(), "too short");
        assert!(species_id_error(&"a".repeat(25)).is_some(), "too long");
        assert!(species_id_error("CoolBeast").is_some(), "uppercase");
        assert!(species_id_error("cool-beast").is_some(), "punctuation");
        assert!(species_id_error("../../etc").is_some(), "path traversal");
        assert!(species_id_error("cool beast").is_some(), "space");
    }

    #[test]
    fn art_has_to_be_something_a_client_can_load() {
        assert!(art_uri_error("https://art.example/x/1.gif").is_none());

        // Most wallets are https pages: a plain-http image is blocked as
        // mixed content and the pet shows as broken.
        assert!(art_uri_error("http://art.example/x/1.gif").is_some());
        assert!(art_uri_error("/assets/animation/x/1.gif").is_some());
        assert!(art_uri_error("ipfs://whatever").is_some());
        // A credential written into a url on a public chain is a published
        // credential.
        assert!(art_uri_error("https://user:pass@art.example/x.gif").is_some());
        assert!(art_uri_error("https://art.example/a b.gif").is_some());
        assert!(art_uri_error("").is_some());
        assert!(art_uri_error(&format!("https://a.example/{}", "x".repeat(300))).is_some());
    }

    #[test]
    #[should_panic(expected = "one drawing per evolution phase")]
    fn a_species_without_every_phase_is_refused() {
        let mut contract = deploy();
        let price = contract.get_species_price().0;
        testing_env!(ctx(alice(), 0, price).build());
        contract.create_species(
            "coolbeast".to_string(),
            "Beast".to_string(),
            vec!["https://art.example/1.gif".to_string()],
        );
    }

    #[test]
    #[should_panic(expected = "An art url must start with https://")]
    fn a_species_with_unloadable_art_is_refused() {
        let mut contract = deploy();
        let price = contract.get_species_price().0;
        testing_env!(ctx(alice(), 0, price).build());
        contract.create_species(
            "coolbeast".to_string(),
            "Beast".to_string(),
            vec![
                "https://art.example/1.gif".to_string(),
                "http://art.example/2.gif".to_string(),
                "https://art.example/3.gif".to_string(),
            ],
        );
    }

    #[test]
    fn the_registry_is_what_get_config_reports() {
        // A client that built its mint form from this used to go stale the
        // moment somebody added an animal.
        let mut contract = deploy();
        add_species(&mut contract, alice(), "coolbeast");

        let config = contract.get_config();
        let listed = config["categories"].as_array().unwrap();
        assert_eq!(listed.len(), 3);
        assert!(listed.iter().any(|c| c == "coolbeast"));
    }

    // ── Creator royalty ──────────────────────────────────────────────────────

    #[test]
    fn a_species_creator_is_paid_a_cut_of_every_mint() {
        /*
         * The reason to make a second species. `minted` counted mints from
         * the day the registry shipped and paid nothing for them, which is
         * a scoreboard with no prize.
         */
        let mut contract = deploy();
        add_species(&mut contract, alice(), "coolbeast");
        let before = contract.get_revenue_banked().0;

        testing_env!(ctx(bob(), 0, 2 * ONE_NEAR).build());
        contract.create_pet("NEWT".to_string(), "coolbeast".to_string());

        // One percent to alice, the rest banked for the treasury.
        let royalty = 2 * ONE_NEAR / 100;
        assert_eq!(contract.get_revenue_banked().0 - before, 2 * ONE_NEAR - royalty);
    }

    #[test]
    fn the_cut_is_taken_from_what_was_paid_not_from_the_price() {
        // Overpaying is revenue, and the creator's share of it is theirs too
        // — otherwise the split silently changes with every overpayment.
        let mut contract = deploy();
        add_species(&mut contract, alice(), "coolbeast");
        let before = contract.get_revenue_banked().0;

        testing_env!(ctx(bob(), 0, 10 * ONE_NEAR).build());
        contract.create_pet("NEWT".to_string(), "coolbeast".to_string());

        assert_eq!(
            contract.get_revenue_banked().0 - before,
            10 * ONE_NEAR - 10 * ONE_NEAR / 100
        );
    }

    #[test]
    fn the_shipped_species_pay_nobody() {
        /*
         * Their creator is this contract. Paying yourself costs gas and moves
         * no money, and it would also make `revenue_banked` understate what
         * is sweepable by one percent of every dragon ever minted.
         */
        let mut contract = deploy();
        let before = contract.get_revenue_banked().0;

        testing_env!(ctx(alice(), 0, 2 * ONE_NEAR).build());
        contract.create_pet("SMAUG".to_string(), "blackdragon".to_string());

        assert_eq!(contract.get_revenue_banked().0 - before, 2 * ONE_NEAR);
    }

    #[test]
    fn a_router_mint_pays_the_creator_too() {
        /*
         * This used to be a recorded gap: the router held the payment, so a
         * pet bought with ZEC or SOL paid its species' creator nothing. The
         * router now turns the wNEAR back into NEAR and attaches it, and the
         * split is the same as a direct mint.
         */
        let mut contract = deploy();
        add_species(&mut contract, alice(), "coolbeast");
        let before = contract.get_revenue_banked().0;

        testing_env!(ctx(router(), 0, 2 * ONE_NEAR).build());
        let pet_id = contract.create_pet_for(bob(), "NEWT".to_string(), "coolbeast".to_string());

        let royalty = 2 * ONE_NEAR / 100;
        assert_eq!(contract.get_revenue_banked().0 - before, 2 * ONE_NEAR - royalty);
        assert_eq!(contract.get_pet(pet_id).unwrap().owner_id, bob());
    }

    #[test]
    #[should_panic(expected = "The router must attach the mint price")]
    fn the_router_cannot_mint_for_free() {
        // Free router mints are how the gap stayed open; refusing them keeps it shut.
        let mut contract = deploy();
        testing_env!(ctx(router(), 0, 0).build());
        contract.create_pet_for(bob(), "NEWT".to_string(), "blackdragon".to_string());
    }

    #[test]
    fn the_owner_can_still_gift_a_pet() {
        let mut contract = deploy();
        let before = contract.get_revenue_banked().0;
        testing_env!(ctx(owner(), 0, 0).build());
        let pet_id = contract.create_pet_for(bob(), "GIFT".to_string(), "blackdragon".to_string());
        assert_eq!(contract.get_pet(pet_id).unwrap().owner_id, bob());
        assert_eq!(contract.get_revenue_banked().0, before);
    }

    #[test]
    #[should_panic(expected = "Unknown pet category")]
    fn minting_an_unknown_species_is_refused_before_any_money_moves() {
        let mut contract = deploy();
        testing_env!(ctx(alice(), 0, 2 * ONE_NEAR).build());
        contract.create_pet("NEWT".to_string(), "nosuchthing".to_string());
    }

    #[test]
    fn the_royalty_and_the_treasury_always_add_up_to_what_was_paid() {
        // Integer division truncates, and a split that loses a yoctoNEAR per
        // mint is a contract that slowly stops balancing.
        let mut contract = deploy();
        add_species(&mut contract, alice(), "coolbeast");

        for paid in [2 * ONE_NEAR, 2 * ONE_NEAR + 1, 3 * ONE_NEAR + 7, 99 * ONE_NEAR / 10] {
            let before = contract.get_revenue_banked().0;
            testing_env!(ctx(bob(), 0, paid).build());
            contract.create_pet("N".to_string(), "coolbeast".to_string());

            let banked = contract.get_revenue_banked().0 - before;
            let royalty = paid * 100 / 10_000;
            assert_eq!(banked + royalty, paid, "a yoctoNEAR went missing at {paid}");
        }
    }

    // ── Revenue ──────────────────────────────────────────────────────────────

    #[test]
    fn minting_and_registering_both_bank_revenue() {
        let mut contract = deploy();

        testing_env!(ctx(alice(), 0, 3 * ONE_NEAR).build());
        contract.create_pet("SMAUG".to_string(), "blackdragon".to_string());
        // The whole deposit, not the price: nothing is refunded, so the
        // extra NEAR is revenue too and the treasury should see it.
        assert_eq!(contract.get_revenue_banked().0, 3 * ONE_NEAR);

        let price = contract.get_species_price().0;
        testing_env!(ctx(bob(), 0, price).build());
        contract.create_species("coolbeast".to_string(), "Beast".to_string(), art("c"));
        assert_eq!(contract.get_revenue_banked().0, 3 * ONE_NEAR + price);
    }

    #[test]
    fn a_mint_through_the_router_banks_nothing_here() {
        // The router took the payment on its own account; this contract was
        // handed a pet to create, not money. Counting it would have the
        // treasury swept twice for one sale.
        let mut contract = deploy();
        mint(&mut contract, alice(), 0);
        assert_eq!(contract.get_revenue_banked().0, 0);
    }

    #[test]
    fn sweeping_sends_the_counter_and_empties_it() {
        let mut contract = deploy();
        testing_env!(ctx(alice(), 0, 2 * ONE_NEAR).build());
        contract.create_pet("SMAUG".to_string(), "blackdragon".to_string());

        testing_env!(ctx(bob(), 0, 0).build());
        contract.sweep_revenue().detach();
        assert_eq!(contract.get_revenue_banked().0, 0);
    }

    #[test]
    #[should_panic(expected = "Nothing banked to sweep")]
    fn sweeping_nothing_is_refused_rather_than_sending_zero() {
        // A zero transfer still costs gas and still logs, which would make
        // the treasury's history unreadable.
        let mut contract = deploy();
        testing_env!(ctx(bob(), 0, 0).build());
        contract.sweep_revenue().detach();
    }

    #[test]
    fn sweeping_never_offers_the_storage_staking() {
        /*
         * The counter exists because the balance is not the revenue. This
         * account also holds the NEP-171 storage staking for every token
         * ever minted, and sweeping that takes the contract below its own
         * storage cost — which cannot be undone without sending NEAR back.
         */
        let mut contract = deploy();
        for _ in 0..5 {
            mint(&mut contract, alice(), 0);
        }
        // Five pets' worth of storage sits on this account, and none of it
        // is sweepable, because none of it was charged as revenue.
        assert_eq!(contract.get_revenue_banked().0, 0);
    }

    // ── Rarity ───────────────────────────────────────────────────────────────

    #[test]
    fn rarity_odds_cover_the_whole_range_and_sum_to_one() {
        let total: u32 = Rarity::ODDS_BPS.iter().map(|(_, bps)| bps).sum();
        assert_eq!(total, 10_000, "odds must be exhaustive");

        assert_eq!(Rarity::from_roll(0), Rarity::Common);
        assert_eq!(Rarity::from_roll(6_999), Rarity::Common);
        assert_eq!(Rarity::from_roll(7_000), Rarity::Rare);
        assert_eq!(Rarity::from_roll(8_999), Rarity::Rare);
        assert_eq!(Rarity::from_roll(9_000), Rarity::Epic);
        assert_eq!(Rarity::from_roll(9_799), Rarity::Epic);
        assert_eq!(Rarity::from_roll(9_800), Rarity::Legendary);
        assert_eq!(Rarity::from_roll(9_999), Rarity::Legendary);
    }

    #[test]
    fn rarer_pets_start_stronger() {
        let (common_atk, _) = Rarity::Common.base_stats();
        let (legendary_atk, _) = Rarity::Legendary.base_stats();
        assert!(legendary_atk > common_atk);
        // Not so much stronger that rarity alone decides every fight.
        assert!(legendary_atk < common_atk * 3);
    }

    // ── Minting ──────────────────────────────────────────────────────────────

    #[test]
    fn minting_creates_a_token_and_a_pet() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 10);

        assert_eq!(pet_id, 1);
        assert_eq!(contract.nft_total_supply(), U128(1));
        assert_eq!(contract.nft_supply_for_owner(alice()), U128(1));

        let pet = contract.get_pet(pet_id).unwrap();
        assert_eq!(pet.owner_id, alice());
        assert_eq!(pet.level, 0);
        assert_eq!(pet.evolution_phase, 1);
        assert!(!pet.locked);

        // The attributes pet-stake reads must line up with the pet.
        let (stake_owner, attrs) = contract.get_pet_attrs(pet_id);
        assert_eq!(stake_owner, alice());
        assert_eq!(attrs.level, 0);
        assert_eq!(attrs.evolution_phase, 1);
    }

    #[test]
    #[should_panic(expected = "Only the mint router")]
    fn players_cannot_mint_for_other_accounts() {
        let mut contract = deploy();
        testing_env!(ctx(alice(), 10, 0).build());
        contract.create_pet_for(bob(), "FREE".to_string(), "blackdragon".to_string());
    }

    #[test]
    #[should_panic(expected = "Unknown pet category")]
    fn rejects_unknown_categories() {
        let mut contract = deploy();
        testing_env!(ctx(owner(), 10, 0).build());
        contract.create_pet_for(alice(), "NOPE".to_string(), "unicorn".to_string());
    }

    #[test]
    #[should_panic(expected = "at least the mint price")]
    fn minting_for_yourself_costs_the_mint_price() {
        let mut contract = deploy();
        testing_env!(ctx(alice(), 10, ONE_NEAR).build());
        contract.create_pet("CHEAP".to_string(), "blackdragon".to_string());
    }

    // ── Status, derived rather than stored ───────────────────────────────────

    #[test]
    fn status_is_computed_from_the_deadline() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        // Fresh: a full day of food.
        assert_eq!(contract.get_pet(pet_id).unwrap().status, PetStatus::Happy);

        // Under three hours left.
        testing_env!(ctx(alice(), 100 + STARVE_SECONDS - 3_000, 0).build());
        assert_eq!(contract.get_pet(pet_id).unwrap().status, PetStatus::Hungry);

        // Past the deadline. v1 would still have said HAPPY here.
        testing_env!(ctx(alice(), 100 + STARVE_SECONDS + 1, 0).build());
        assert_eq!(contract.get_pet(pet_id).unwrap().status, PetStatus::Dying);
        assert!(!contract.is_pet_alive(pet_id));
    }

    // ── Feeding ──────────────────────────────────────────────────────────────

    #[test]
    fn feeding_extends_the_clock_and_grants_xp() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);
        let before = contract.get_pet(pet_id).unwrap().starves_at.0;

        // Beef: 0.10 NEAR, +3h, 30 XP.
        testing_env!(ctx(alice(), 100, ONE_NEAR).build());
        contract.buy_item(pet_id, 1);

        let after = contract.get_pet(pet_id).unwrap();
        assert_eq!(after.starves_at.0, before + 3 * 3_600 * NANOS_PER_SECOND);
        assert_eq!(after.xp, 30);
    }

    #[test]
    fn banked_food_is_capped() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        // Feed far more than the ceiling allows.
        for _ in 0..100 {
            testing_env!(ctx(alice(), 100, ONE_NEAR).build());
            contract.buy_item(pet_id, 1);
        }

        let pet = contract.get_pet(pet_id).unwrap();
        let ceiling = (100 + MAX_STARVE_SECONDS) * NANOS_PER_SECOND;
        assert!(
            pet.starves_at.0 <= ceiling,
            "a pet must not be made immortal in one sitting"
        );
    }

    #[test]
    #[should_panic(expected = "use a revival item")]
    fn a_starved_pet_needs_holy_water() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(alice(), 100 + STARVE_SECONDS + 1, ONE_NEAR).build());
        contract.buy_item(pet_id, 1); // Beef
    }

    #[test]
    fn holy_water_revives() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        let at = 100 + STARVE_SECONDS + 1;
        testing_env!(ctx(alice(), at, ONE_NEAR).build());
        contract.buy_item(pet_id, 4); // Holy Water

        assert!(contract.is_pet_alive(pet_id));
    }

    #[test]
    fn credits_evolve_a_pet_that_has_the_levels() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        // Phase 1 needs level 5.
        testing_env!(ctx(stake(), 100, 0).build());
        for _ in 0..6 {
            let need = contract.get_pet(pet_id).unwrap().xp_for_next_level;
            contract.award_xp(pet_id, need);
        }

        assert!(contract.evolve_from_stake(pet_id, alice()));
        assert_eq!(contract.get_pet(pet_id).unwrap().evolution_phase, 2);
    }

    #[test]
    fn evolving_without_the_levels_is_refused_rather_than_charged() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        assert!(!contract.evolve_from_stake(pet_id, alice()));
    }

    #[test]
    fn an_evolve_refuses_somebody_elses_pet() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        assert!(!contract.evolve_from_stake(pet_id, bob()));
    }

    #[test]
    #[should_panic(expected = "Only the staking contract")]
    fn nobody_else_may_evolve_for_an_owner() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(alice(), 100, 0).build());
        contract.evolve_from_stake(pet_id, alice());
    }

    #[test]
    fn credits_revive_a_starved_pet() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        let at = 100 + STARVE_SECONDS + 1;
        testing_env!(ctx(stake(), at, 0).build());
        assert!(contract.revive_from_stake(pet_id, alice()));
        assert!(contract.is_pet_alive(pet_id));
    }

    #[test]
    fn a_revival_buys_a_full_meal_of_time() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        let at = 100 + STARVE_SECONDS + 1;
        testing_env!(ctx(stake(), at, 0).build());
        contract.revive_from_stake(pet_id, alice());

        // Twelve hours, not Holy Water's three: a pet revived with three
        // hours left dies again before most people look at it.
        let pet = contract.get_pet(pet_id).unwrap();
        assert_eq!(pet.starves_at.0, (at + REVIVE_SECONDS) * NANOS_PER_SECOND);
    }

    #[test]
    fn reviving_a_living_pet_is_refused_rather_than_charged() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(stake(), 200, 0).build());
        assert!(!contract.revive_from_stake(pet_id, alice()));
    }

    #[test]
    fn a_revival_refuses_somebody_elses_pet() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        let at = 100 + STARVE_SECONDS + 1;
        testing_env!(ctx(stake(), at, 0).build());
        assert!(!contract.revive_from_stake(pet_id, bob()));
    }

    #[test]
    fn a_revival_refuses_a_pet_that_does_not_exist() {
        let mut contract = deploy();
        testing_env!(ctx(stake(), 200, 0).build());
        assert!(!contract.revive_from_stake(999, alice()));
    }

    #[test]
    #[should_panic(expected = "Only the staking contract")]
    fn nobody_else_may_revive() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        let at = 100 + STARVE_SECONDS + 1;
        testing_env!(ctx(alice(), at, 0).build());
        contract.revive_from_stake(pet_id, alice());
    }

    #[test]
    fn levelling_follows_the_published_curve() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        // The curve is read from the constants rather than copied, so
        // changing them is one edit instead of two that can disagree.
        let first = BASE_LEVEL_XP;
        assert_eq!(contract.get_pet(pet_id).unwrap().xp_for_next_level, first);

        testing_env!(ctx(stake(), 100, 0).build());
        contract.award_xp(pet_id, first);

        let pet = contract.get_pet(pet_id).unwrap();
        assert_eq!(pet.level, 1);
        assert_eq!(pet.xp, 0);
        assert_eq!(
            pet.xp_for_next_level,
            (first as u64 * LEVEL_XP_GROWTH_PERCENT / 100) as u32
        );
        // Stats grow with level, so combat keeps pace with staking weight.
        assert_eq!(pet.atk, 104);
    }

    #[test]
    #[should_panic(expected = "Only the staking contract")]
    fn players_cannot_award_themselves_xp() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);
        testing_env!(ctx(alice(), 100, 0).build());
        contract.award_xp(pet_id, 500);
    }

    // ── Locking ──────────────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Only the staking contract can lock")]
    fn players_cannot_lock_pets() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);
        testing_env!(ctx(alice(), 100, 0).build());
        contract.set_locked(pet_id, true);
    }

    #[test]
    #[should_panic(expected = "at work in the AI Lab")]
    fn a_staked_pet_cannot_be_transferred() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        contract.set_locked(pet_id, true);

        testing_env!(ctx(alice(), 100, 1).build());
        contract.nft_transfer(bob(), pet_id.to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "at work in the AI Lab")]
    fn a_staked_pet_cannot_be_approved_either() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        contract.set_locked(pet_id, true);

        testing_env!(ctx(alice(), 100, ONE_NEAR).build());
        contract.nft_approve(pet_id.to_string(), bob(), None);
    }

    #[test]
    fn unlocking_makes_a_pet_transferable_again() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        contract.set_locked(pet_id, true);
        contract.set_locked(pet_id, false);

        testing_env!(ctx(alice(), 100, 1).build());
        contract.nft_transfer(bob(), pet_id.to_string(), None, None);

        // Both the standard and the game's own record move.
        assert_eq!(contract.nft_supply_for_owner(bob()), U128(1));
        assert_eq!(contract.get_pet(pet_id).unwrap().owner_id, bob());
        assert_eq!(contract.get_pet_attrs(pet_id).0, bob());
    }

    // ── Battle ───────────────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "same owner")]
    fn cannot_attack_your_own_pet() {
        let mut contract = deploy();
        let a = mint(&mut contract, alice(), 100);
        let b = mint(&mut contract, alice(), 100);

        testing_env!(ctx(alice(), 100, 0).build());
        let _ = contract.attack(a, b);
    }

    #[test]
    fn a_pet_at_work_can_be_attacked() {
        // The other half of the rule that is gone. A pet in the lab is a
        // legal target, or every pet worth fighting is unreachable: staking
        // is the only income, so the healthy pets are exactly the staked ones.
        let mut contract = deploy();
        let mine = mint(&mut contract, alice(), 100);
        let theirs = mint(&mut contract, bob(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        contract.set_locked(theirs, true);

        testing_env!(ctx(alice(), 100, 0).build());
        let _ = contract.attack(mine, theirs);
    }

    #[test]
    #[should_panic(expected = "has starved")]
    fn a_starved_pet_cannot_attack() {
        let mut contract = deploy();
        let mine = mint(&mut contract, alice(), 100);
        let theirs = mint(&mut contract, bob(), 100);

        testing_env!(ctx(alice(), 100 + STARVE_SECONDS + 1, 0).build());
        let _ = contract.attack(mine, theirs);
    }

    #[test]
    fn a_pet_at_work_can_still_fight() {
        // The rule that refused this made battle impossible rather than
        // restricted: staking is the only way to earn credits, so every pet
        // worth fighting was at work and no legal pairing existed.
        let mut contract = deploy();
        let mine = mint(&mut contract, alice(), 100);
        let theirs = mint(&mut contract, bob(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        contract.set_locked(mine, true);
        contract.set_locked(theirs, true);

        testing_env!(ctx(alice(), 100, 0).build());
        let _ = contract.attack(mine, theirs);
    }

    #[test]
    fn a_staked_winner_that_levels_asks_for_a_re_weight() {
        // `sync_weight` returns early unless the pet is locked, so until a
        // staked pet could fight, this branch could never run after a battle.
        let mut contract = deploy();
        let mine = mint(&mut contract, alice(), 100);
        let theirs = mint(&mut contract, bob(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        contract.set_locked(mine, true);

        // Right up against the threshold, so one win crosses it.
        testing_env!(ctx(stake(), 100, 0).build());
        contract.award_xp(mine, contract.get_pet(mine).unwrap().xp_for_next_level - 1);
        let before = contract.get_pet(mine).unwrap().level;

        contract.on_battle_settled(
            mine,
            theirs,
            Ok(BattleOutcome { transferred: U128(0), rake: U128(0), star_protected: false }),
        );

        assert!(contract.get_pet(mine).unwrap().level > before, "the win levelled it");
        assert!(contract.get_pet(mine).unwrap().locked, "and it is still at work");
    }

    #[test]
    #[should_panic(expected = "at work in the AI Lab")]
    fn a_pet_at_work_still_cannot_be_sold() {
        // DECISION 3, which is the whole of what `locked` is for. Battling
        // moves no ownership; a sale does.
        let mut contract = deploy();
        let mine = mint(&mut contract, alice(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        contract.set_locked(mine, true);

        testing_env!(ctx(alice(), 100, ONE_NEAR).build());
        contract.list_pet(mine, U128(ONE_NEAR));
    }

    #[test]
    fn attacking_leaves_the_pets_untouched_until_the_callback() {
        let mut contract = deploy();
        let mine = mint(&mut contract, alice(), 100);
        let theirs = mint(&mut contract, bob(), 100);

        let before = contract.get_pet(theirs).unwrap();

        testing_env!(ctx(alice(), 100, 0).build());
        let _ = contract.attack(mine, theirs);

        // Nothing is applied yet: the settlement has not come back. This is the
        // whole reason `report_battle` is called before damage is dealt.
        let after = contract.get_pet(theirs).unwrap();
        assert_eq!(after.star, before.star);
        assert_eq!(after.starves_at.0, before.starves_at.0);
        assert_eq!(after.last_attacked.0, 0);
    }

    #[test]
    fn a_rejected_settlement_damages_nobody() {
        let mut contract = deploy();
        let mine = mint(&mut contract, alice(), 100);
        let theirs = mint(&mut contract, bob(), 100);
        let before = contract.get_pet(theirs).unwrap();

        testing_env!(ctx("game.near".parse().unwrap(), 100, 0).build());
        let applied = contract.on_battle_settled(mine, theirs, Err(PromiseError::Failed));

        assert!(!applied);
        let after = contract.get_pet(theirs).unwrap();
        assert_eq!(after.star, before.star);
        assert_eq!(after.starves_at.0, before.starves_at.0);
    }

    fn outcome(star_protected: bool) -> BattleOutcome {
        BattleOutcome {
            transferred: U128(9_500),
            rake: U128(500),
            star_protected,
        }
    }

    /// Win `times` battles against a fresh opponent each time, so the win
    /// streak builds the way it would in play.
    fn win_battles(contract: &mut Game, winner_pet: u64, times: u32) {
        for i in 0..times {
            testing_env!(ctx("game.near".parse().unwrap(), 100 + i as u64, 0).build());
            let loser = mint(contract, bob(), 100 + i as u64);
            contract.on_battle_settled(winner_pet, loser, Ok(outcome(false)));
        }
    }

    #[test]
    fn three_wins_earn_a_star() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        assert_eq!(contract.get_pet(pet_id).unwrap().star, 0);
        assert_eq!(contract.get_pet(pet_id).unwrap().wins_to_next_star, Some(3));

        win_battles(&mut contract, pet_id, 2);
        let after_two = contract.get_pet(pet_id).unwrap();
        assert_eq!(after_two.star, 0, "two wins is not enough");
        assert_eq!(after_two.win_streak, 2);
        assert_eq!(after_two.wins_to_next_star, Some(1));

        win_battles(&mut contract, pet_id, 1);
        let after_three = contract.get_pet(pet_id).unwrap();
        assert_eq!(after_three.star, 1, "the third win earns it");
        assert_eq!(after_three.win_streak, 0, "and the streak restarts");
    }

    #[test]
    fn a_defeat_wipes_the_streak_and_takes_a_star() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);
        let rival = mint(&mut contract, bob(), 100);

        // Earn one star, then build towards the next.
        win_battles(&mut contract, pet_id, 4);
        let before = contract.get_pet(pet_id).unwrap();
        assert_eq!(before.star, 1);
        assert_eq!(before.win_streak, 1);

        // Now lose.
        testing_env!(ctx("game.near".parse().unwrap(), 200, 0).build());
        contract.on_battle_settled(rival, pet_id, Ok(outcome(false)));

        let after = contract.get_pet(pet_id).unwrap();
        assert_eq!(after.star, 0, "the star is lost");
        assert_eq!(after.win_streak, 0, "and so is the progress towards the next");
    }

    #[test]
    fn a_star_charm_saves_an_earned_star() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);
        let rival = mint(&mut contract, bob(), 100);

        win_battles(&mut contract, pet_id, 3);
        assert_eq!(contract.get_pet(pet_id).unwrap().star, 1);

        testing_env!(ctx("game.near".parse().unwrap(), 200, 0).build());
        contract.on_battle_settled(rival, pet_id, Ok(outcome(true)));

        assert_eq!(
            contract.get_pet(pet_id).unwrap().star,
            1,
            "the charm is what makes this purchase worth anything"
        );
    }

    #[test]
    fn stars_stop_at_the_cap() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        win_battles(&mut contract, pet_id, WINS_PER_STAR * MAX_STAR + 6);

        let pet = contract.get_pet(pet_id).unwrap();
        assert_eq!(pet.star, MAX_STAR);
        assert_eq!(pet.wins_to_next_star, None, "nothing left to earn");
    }

    #[test]
    fn stars_raise_combat_strength() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);
        let before = contract.get_pet(pet_id).unwrap().effective_atk.0;

        win_battles(&mut contract, pet_id, 3);
        let after = contract.get_pet(pet_id).unwrap();

        assert_eq!(after.star, 1);
        assert!(
            after.effective_atk.0 > before,
            "a star has to mean something in a fight"
        );
    }

    #[test]
    fn losing_costs_a_star_and_time_but_never_the_pet() {
        let mut contract = deploy();
        let winner = mint(&mut contract, alice(), 100);
        let loser = mint(&mut contract, bob(), 100);

        // Give the loser a star to lose.
        testing_env!(ctx(stake(), 100, 0).build());
        contract.award_xp(loser, 0);
        let mut pet = contract.pets.get(&loser).unwrap();
        pet.star = 2;
        contract.pets.insert(&loser, &pet);
        let before = contract.get_pet(loser).unwrap();

        testing_env!(ctx("game.near".parse().unwrap(), 100, 0).build());
        assert!(contract.on_battle_settled(winner, loser, Ok(outcome(false))));

        let after = contract.get_pet(loser).unwrap();
        assert_eq!(after.star, 1, "one star lost");
        assert!(after.starves_at.0 < before.starves_at.0, "time lost");
        assert!(contract.is_pet_alive(loser), "but the pet survives");
        assert!(after.last_attacked.0 > 0);
    }

    #[test]
    fn a_star_charm_saves_the_star() {
        let mut contract = deploy();
        let winner = mint(&mut contract, alice(), 100);
        let loser = mint(&mut contract, bob(), 100);

        let mut pet = contract.pets.get(&loser).unwrap();
        pet.star = 2;
        contract.pets.insert(&loser, &pet);

        testing_env!(ctx("game.near".parse().unwrap(), 100, 0).build());
        contract.on_battle_settled(winner, loser, Ok(outcome(true)));

        assert_eq!(contract.get_pet(loser).unwrap().star, 2);
    }

    #[test]
    fn a_shield_absorbs_the_hit_before_the_star_does() {
        let mut contract = deploy();
        let winner = mint(&mut contract, alice(), 100);
        let loser = mint(&mut contract, bob(), 100);

        let mut pet = contract.pets.get(&loser).unwrap();
        pet.star = 2;
        pet.shield = 1;
        contract.pets.insert(&loser, &pet);

        testing_env!(ctx("game.near".parse().unwrap(), 100, 0).build());
        contract.on_battle_settled(winner, loser, Ok(outcome(false)));

        let after = contract.get_pet(loser).unwrap();
        assert_eq!(after.shield, 0, "the shield is spent");
        assert_eq!(after.star, 2, "and the star survives");
    }

    #[test]
    fn the_winner_gains_xp() {
        let mut contract = deploy();
        let winner = mint(&mut contract, alice(), 100);
        let loser = mint(&mut contract, bob(), 100);

        testing_env!(ctx("game.near".parse().unwrap(), 100, 0).build());
        contract.on_battle_settled(winner, loser, Ok(outcome(false)));

        assert_eq!(contract.get_pet(winner).unwrap().xp, 25);
    }

    #[test]
    fn battle_scores_follow_the_stats() {
        let mut contract = deploy();
        let weak = mint(&mut contract, alice(), 100);
        let strong = mint(&mut contract, bob(), 100);

        // Level the defender well past the attacker.
        testing_env!(ctx(stake(), 100, 0).build());
        contract.award_xp(strong, 400);

        let attacker = contract.pets.get(&weak).unwrap();
        let defender = contract.pets.get(&strong).unwrap();
        assert!(
            defender.effective_def() > attacker.effective_def(),
            "levels must actually make a pet tougher"
        );
    }

    // ── Evolution ────────────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Not enough levels")]
    fn evolving_needs_levels() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);
        testing_env!(ctx(alice(), 100, 0).build());
        contract.evolve(pet_id);
    }

    #[test]
    fn evolving_advances_the_phase() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        contract.award_xp(pet_id, 500);
        contract.award_xp(pet_id, 500);

        testing_env!(ctx(alice(), 100, 0).build());
        contract.evolve(pet_id);

        let pet = contract.get_pet(pet_id).unwrap();
        assert_eq!(pet.evolution_phase, 2);
        // The attributes pet-stake re-reads reflect it.
        assert_eq!(contract.get_pet_attrs(pet_id).1.evolution_phase, 2);
    }

    // ── Marketplace ──────────────────────────────────────────────────────────

    /// The bug this pins made the pets invisible rather than broken.
    ///
    /// `internal_mint_with_refund` is the one function in the standard that
    /// emits nothing — `internal_mint` is the wrapper that emits `nft_mint`,
    /// and we cannot use it because it would refund the mint price. So the
    /// tokens existed, `nft_token` returned them, and no explorer, wallet or
    /// marketplace had any idea they were there: all of them build NFT
    /// ownership from `nep171` events, never by polling `nft_tokens`.
    #[test]
    fn minting_emits_the_nep171_event_indexers_actually_read() {
        let mut contract = deploy();
        testing_env!(ctx(alice(), 0, 2 * ONE_NEAR).build());
        let pet_id = contract.create_pet("SMAUG".to_string(), "blackdragon".to_string());

        let events: Vec<String> = near_sdk::test_utils::get_logs()
            .into_iter()
            .filter(|line| line.starts_with("EVENT_JSON:"))
            .collect();

        let nep171 = events
            .iter()
            .find(|line| line.contains("\"standard\":\"nep171\""))
            .unwrap_or_else(|| panic!("no nep171 event among {events:?}"));

        assert!(nep171.contains("\"event\":\"nft_mint\""), "{nep171}");
        assert!(nep171.contains(&format!("\"{pet_id}\"")), "{nep171}");
        assert!(nep171.contains("alice.near"), "{nep171}");

        // The game's own event stays: it carries rarity and category, which
        // nep171 has no field for.
        assert!(
            events.iter().any(|line| line.contains("\"event\":\"pet_minted\"")),
            "{events:?}"
        );
    }

    #[test]
    fn a_sale_emits_the_transfer_event_so_ownership_can_be_followed() {
        // `internal_transfer_unguarded` skips the approval checks `buy_pet`
        // has already done — and skips the event with them. Without this, an
        // indexer keeps showing the seller as the owner forever.
        let mut contract = deploy();

        testing_env!(ctx(alice(), 0, 2 * ONE_NEAR).build());
        let pet_id = contract.create_pet("SMAUG".to_string(), "blackdragon".to_string());

        testing_env!(ctx(alice(), 0, 1).build());
        contract.list_pet(pet_id, U128(ONE_NEAR));

        testing_env!(ctx(bob(), 0, ONE_NEAR).build());
        let _refund = contract.buy_pet(pet_id);

        let logs = near_sdk::test_utils::get_logs();
        let transfer = logs
            .iter()
            .find(|line| line.contains("\"event\":\"nft_transfer\""))
            .unwrap_or_else(|| panic!("no nft_transfer event: {logs:?}"));

        assert!(transfer.contains("\"standard\":\"nep171\""), "{transfer}");
        assert!(transfer.contains("alice.near"), "{transfer}");
        assert!(transfer.contains("bob.near"), "{transfer}");
    }

    #[test]
    fn a_pet_sells_for_near_and_the_treasury_takes_its_cut() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(alice(), 100, 1).build());
        contract.list_pet(pet_id, U128(5 * ONE_NEAR));

        let listing = contract.get_pet_listing(pet_id).unwrap();
        assert_eq!(listing.seller_id, alice());
        assert_eq!(listing.price.0, 5 * ONE_NEAR);
        assert_eq!(
            contract.get_pet(pet_id).unwrap().listed_price,
            Some(U128(5 * ONE_NEAR))
        );

        testing_env!(ctx(bob(), 110, 5 * ONE_NEAR).build());
        let _ = contract.buy_pet(pet_id);

        // Both the standard's record and the game's own move together.
        assert_eq!(contract.get_pet(pet_id).unwrap().owner_id, bob());
        assert_eq!(contract.get_pet_attrs(pet_id).0, bob());
        assert_eq!(contract.nft_supply_for_owner(bob()), U128(1));
        assert_eq!(contract.nft_supply_for_owner(alice()), U128(0));

        // And the sale is over.
        assert!(contract.get_pet_listing(pet_id).is_none());
        assert!(contract.get_pet(pet_id).unwrap().listed_price.is_none());
    }

    #[test]
    #[should_panic(expected = "at work in the AI Lab")]
    fn a_staked_pet_cannot_be_listed() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(stake(), 100, 0).build());
        contract.set_locked(pet_id, true);

        testing_env!(ctx(alice(), 100, 1).build());
        contract.list_pet(pet_id, U128(ONE_NEAR));
    }

    #[test]
    fn staking_a_listed_pet_pulls_the_listing() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(alice(), 100, 1).build());
        contract.list_pet(pet_id, U128(ONE_NEAR));
        assert!(contract.get_pet_listing(pet_id).is_some());

        testing_env!(ctx(stake(), 100, 0).build());
        contract.set_locked(pet_id, true);

        assert!(
            contract.get_pet_listing(pet_id).is_none(),
            "a buyer must not be sold a pet that cannot be moved"
        );
    }

    #[test]
    fn transferring_a_listed_pet_ends_the_sale() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(alice(), 100, 1).build());
        contract.list_pet(pet_id, U128(ONE_NEAR));
        contract.nft_transfer(bob(), pet_id.to_string(), None, None);

        assert!(contract.get_pet_listing(pet_id).is_none());
        assert_eq!(contract.get_pet(pet_id).unwrap().owner_id, bob());
    }

    #[test]
    #[should_panic(expected = "at least the asking price")]
    fn underpaying_buys_nothing() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(alice(), 100, 1).build());
        contract.list_pet(pet_id, U128(5 * ONE_NEAR));

        testing_env!(ctx(bob(), 110, 4 * ONE_NEAR).build());
        let _ = contract.buy_pet(pet_id);
    }

    #[test]
    #[should_panic(expected = "listing is yours")]
    fn you_cannot_buy_your_own_pet() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(alice(), 100, 1).build());
        contract.list_pet(pet_id, U128(ONE_NEAR));
        testing_env!(ctx(alice(), 110, ONE_NEAR).build());
        let _ = contract.buy_pet(pet_id);
    }

    #[test]
    #[should_panic(expected = "not for sale")]
    fn you_cannot_buy_what_is_not_listed() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);
        testing_env!(ctx(bob(), 110, ONE_NEAR).build());
        let _ = contract.buy_pet(pet_id);
    }

    #[test]
    #[should_panic(expected = "listing is not yours")]
    fn only_the_seller_can_unlist() {
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 100);

        testing_env!(ctx(alice(), 100, 1).build());
        contract.list_pet(pet_id, U128(ONE_NEAR));

        testing_env!(ctx(bob(), 100, 1).build());
        contract.unlist_pet(pet_id);
    }

    #[test]
    fn the_fee_is_capped() {
        let mut contract = deploy();
        testing_env!(ctx(owner(), 0, 0).build());
        contract.set_market_fee_bps(1_000);
        assert_eq!(
            contract.get_config()["market_fee_bps"].as_u64().unwrap(),
            1_000
        );
    }

    #[test]
    #[should_panic(expected = "cannot exceed 10%")]
    fn the_fee_cannot_be_set_above_the_cap() {
        let mut contract = deploy();
        testing_env!(ctx(owner(), 0, 0).build());
        contract.set_market_fee_bps(1_001);
    }

    // ── Migration ────────────────────────────────────────────────────────────

    #[test]
    fn importing_v1_pets_keeps_their_ids_and_reads_the_timestamp_correctly() {
        let mut contract = deploy();

        // The real pet #1 from mainnet.
        let legacy = LegacyPet {
            pet_id: 1,
            owner_id: "huunhanz-hot.tg".parse().unwrap(),
            name: "PET #1".to_string(),
            category: "blackdragon".to_string(),
            level: 1,
            star: 0,
            pet_evolution_phase: 1,
            time_pet_born: U64(1_722_009_513_921_106_082),
            time_until_starving: U64(1_722_875_218_337_755_475),
        };

        testing_env!(ctx(owner(), 0, 0).build());
        assert_eq!(contract.import_pets(vec![legacy]), 1);

        // Read it from a present-day block, not from timestamp zero.
        testing_env!(ctx(owner(), 1_780_000_000, 0).build());
        let pet = contract.get_pet(1).unwrap();
        assert_eq!(pet.pet_id, 1, "ids are preserved");
        assert_eq!(pet.owner_id.to_string(), "huunhanz-hot.tg");
        // Read as an absolute deadline, which is what it always was.
        assert_eq!(pet.starves_at.0, 1_722_875_218_337_755_475);
        assert_eq!(pet.status, PetStatus::Dying, "it starved in 2024");
        // A new mint must not collide with an imported id.
        assert!(contract.next_pet_id > 1);
    }

    #[test]
    fn importing_is_idempotent() {
        let mut contract = deploy();
        let legacy = || LegacyPet {
            pet_id: 5,
            owner_id: alice(),
            name: "DUPE".to_string(),
            category: "greendragon".to_string(),
            level: 1,
            star: 0,
            pet_evolution_phase: 1,
            time_pet_born: U64(1),
            time_until_starving: U64(2),
        };

        testing_env!(ctx(owner(), 0, 0).build());
        assert_eq!(contract.import_pets(vec![legacy()]), 1);
        assert_eq!(contract.import_pets(vec![legacy()]), 0, "no double import");
        assert_eq!(contract.nft_total_supply(), U128(1));
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn only_the_owner_imports() {
        let mut contract = deploy();
        testing_env!(ctx(alice(), 0, 0).build());
        contract.import_pets(vec![]);
    }

    // ── Retiring a species ───────────────────────────────────────────────────

    fn mint_kind(contract: &mut Game, who: AccountId, kind: &str) -> u64 {
        testing_env!(ctx(owner(), 0, 0).build());
        contract.create_pet_for(who, "N".to_string(), kind.to_string())
    }

    #[test]
    fn retiring_a_house_species_burns_its_pets_and_nothing_else() {
        let mut contract = deploy();
        add_species(&mut contract, router(), "example");
        let a = mint_kind(&mut contract, router(), "example");
        let b = mint_kind(&mut contract, owner(), "example");
        let kept = mint_kind(&mut contract, alice(), "blackdragon");

        testing_env!(ctx(owner(), 0, 0).build());
        assert_eq!(contract.retire_species("example".to_string()), vec![a, b]);

        assert!(contract.get_species("example".to_string()).is_none());
        assert!(contract.get_pet(a).is_none());
        assert!(contract.get_pet(b).is_none());
        assert!(contract.nft_token(a.to_string()).is_none());
        assert!(contract.nft_tokens_for_owner(router(), None, None).is_empty());
        assert_eq!(contract.nft_total_supply().0, 1);
        assert!(contract.get_pet(kept).is_some());
    }

    #[test]
    #[should_panic(expected = "belongs to a player")]
    fn a_species_with_a_players_pet_cannot_be_retired() {
        let mut contract = deploy();
        add_species(&mut contract, router(), "example");
        mint_kind(&mut contract, bob(), "example");
        testing_env!(ctx(owner(), 0, 0).build());
        contract.retire_species("example".to_string());
    }

    #[test]
    #[should_panic(expected = "A built-in species cannot be retired")]
    fn a_built_in_species_cannot_be_retired() {
        let mut contract = deploy();
        testing_env!(ctx(owner(), 0, 0).build());
        contract.retire_species("blackdragon".to_string());
    }

    #[test]
    #[should_panic(expected = "Only the owner can call this")]
    fn only_the_owner_retires_a_species() {
        let mut contract = deploy();
        add_species(&mut contract, alice(), "example");
        testing_env!(ctx(alice(), 0, 0).build());
        contract.retire_species("example".to_string());
    }

    // ── Stale listings ───────────────────────────────────────────────────────

    #[test]
    fn nft_transfer_call_ends_a_sale() {
        // The hole: a listing that outlived `nft_transfer_call` let a buyer
        // take the pet from its new owner and pay the old one.
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 0);
        testing_env!(ctx(alice(), 0, 1).build());
        contract.list_pet(pet_id, U128(ONE_NEAR));

        testing_env!(ctx(alice(), 0, 1).build());
        let _ = contract.nft_transfer_call(bob(), pet_id.to_string(), None, None, String::new());

        assert!(contract.get_pet_listing(pet_id).is_none());
    }

    #[test]
    #[should_panic(expected = "That listing is stale")]
    fn a_listing_by_someone_who_no_longer_owns_the_pet_cannot_be_bought() {
        // Belt and braces: whatever path leaves a listing behind, the sale
        // itself refuses to pay a seller who is not the owner.
        let mut contract = deploy();
        let pet_id = mint(&mut contract, alice(), 0);
        mint(&mut contract, alice(), 0);
        testing_env!(ctx(alice(), 0, 1).build());
        contract.list_pet(pet_id, U128(ONE_NEAR));

        // Move the pet without going through anything that unlists it.
        let token_id = pet_id.to_string();
        contract.tokens.internal_transfer_unguarded(&token_id, &alice(), &bob());
        let mut pet = contract.pets.get(&pet_id).unwrap();
        pet.owner_id = bob();
        contract.pets.insert(&pet_id, &pet);

        let carol: AccountId = "carol.near".parse().unwrap();
        testing_env!(ctx(carol, 0, ONE_NEAR).build());
        contract.buy_pet(pet_id).detach();
    }

    // ── Settling levels ──────────────────────────────────────────────────────

    #[test]
    fn settling_levels_up_a_pet_that_banked_xp_under_the_old_curve() {
        let mut contract = deploy();
        let stuck = mint(&mut contract, alice(), 0);
        let fine = mint(&mut contract, bob(), 0);

        // 81 XP at level 0, with 60 needed — RINGER on testnet.
        let mut pet = contract.pets.get(&stuck).unwrap();
        pet.xp = 81;
        contract.pets.insert(&stuck, &pet);

        testing_env!(ctx(owner(), 0, 0).build());
        assert_eq!(contract.settle_levels(1, 50), vec![stuck]);
        let pet = contract.get_pet(stuck).unwrap();
        assert_eq!((pet.level, pet.xp), (1, 21));
        assert_eq!(contract.get_pet(fine).unwrap().level, 0);

        // Repeating it changes nothing.
        assert!(contract.settle_levels(1, 50).is_empty());
    }

    #[test]
    #[should_panic(expected = "Only the owner can call this")]
    fn only_the_owner_settles_levels() {
        let mut contract = deploy();
        testing_env!(ctx(alice(), 0, 0).build());
        contract.settle_levels(1, 50);
    }
}
