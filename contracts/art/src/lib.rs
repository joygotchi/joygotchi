/*!
Sprite sheets, stored on chain and addressed by their hash.

A species is a row on the game contract with an https url for each phase's
art, and this project has nowhere to host files. Recolours of the two
shipped dragons need no hosting — the web app draws them from a recipe — but
a sheet somebody drew had to arrive as a pull request into the repository,
which made "anyone can register a species" true only for people who use git.

So the sheet lives here. A creator stores the PNG with `put`, paying the
storage it occupies, and gets back its SHA-256. The web app serves it at
`/api/art/<hash>.png`, which is the url the species registers. Nothing can
change or remove a sheet once stored: its address is its content, and pets
point at it for as long as they exist.

Only sheets are accepted: a PNG whose size divides into the 8 × 9 grid every
pet atlas uses, the same rule `atlasFrom` applies in `@joygotchi/pet`.
*/
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LookupMap;
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

/// Largest sheet accepted, in bytes. A 1536 × 1872 sheet of pixel art is
/// typically 50–150 KB; this leaves room and keeps a call under the
/// transaction size limit once base64 is added.
pub const MAX_SHEET_BYTES: usize = 600 * 1024;

pub const ATLAS_COLUMNS: u32 = 8;
pub const ATLAS_ROWS: u32 = 9;
pub const MIN_SHEET_PX: u32 = 256;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Sheets,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Art {
    sheets: LookupMap<String, Vec<u8>>,
    stored: u64,
}

/// Width and height from a PNG's IHDR, or why it isn't one.
pub fn png_size(bytes: &[u8]) -> Result<(u32, u32), &'static str> {
    const SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 24 || bytes[..8] != SIGNATURE || &bytes[12..16] != b"IHDR" {
        return Err("That is not a PNG");
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    Ok((width, height))
}

/// Why this is not a pet sheet, or `None` if it is one.
pub fn sheet_error(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > MAX_SHEET_BYTES {
        return Some("A sheet is at most 600 KB");
    }
    let (width, height) = match png_size(bytes) {
        Ok(size) => size,
        Err(why) => return Some(why),
    };
    if width < MIN_SHEET_PX || height < MIN_SHEET_PX {
        return Some("A sheet is at least 256 × 256");
    }
    if width % ATLAS_COLUMNS != 0 || height % ATLAS_ROWS != 0 {
        return Some("A sheet is 8 frames across and 9 states down: its width must divide by 8 and its height by 9");
    }
    None
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[near]
impl Art {
    #[init]
    pub fn new() -> Self {
        Self {
            sheets: LookupMap::new(StorageKey::Sheets),
            stored: 0,
        }
    }

    /// Store a sheet and return its hash. The deposit pays its storage; any
    /// change is sent back, and storing a sheet that is already here costs
    /// nothing but gas.
    #[payable]
    pub fn put(&mut self, sheet: Base64VecU8) -> String {
        let bytes: Vec<u8> = sheet.into();
        if let Some(why) = sheet_error(&bytes) {
            env::panic_str(why);
        }
        let hash = hex(&env::sha256(&bytes));
        let payer: AccountId = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();

        if self.sheets.contains_key(&hash) {
            if deposit > 0 {
                Promise::new(payer).transfer(NearToken::from_yoctonear(deposit)).detach();
            }
            return hash;
        }

        let before = env::storage_usage();
        self.sheets.insert(&hash, &bytes);
        self.stored += 1;
        let used = env::storage_usage() - before;
        let cost = used as u128 * env::storage_byte_cost().as_yoctonear();
        require!(
            deposit >= cost,
            format!("Attach {cost} yoctoNEAR for the {used} bytes this sheet occupies")
        );
        if deposit > cost {
            Promise::new(payer.clone())
                .transfer(NearToken::from_yoctonear(deposit - cost))
                .detach();
        }

        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({
                "standard": "joygotchi",
                "version": "1.0.0",
                "event": "sheet_stored",
                "data": [{ "hash": hash, "bytes": bytes.len(), "by": payer }],
            })
        ));
        hash
    }

    pub fn get(&self, hash: String) -> Option<Base64VecU8> {
        self.sheets.get(&hash).map(Base64VecU8::from)
    }

    pub fn has(&self, hash: String) -> bool {
        self.sheets.contains_key(&hash)
    }

    /// What storing `bytes` bytes would cost, for a client to attach. An
    /// estimate with headroom for the map key; `put` refunds the rest.
    pub fn storage_cost(&self, bytes: u64) -> near_sdk::json_types::U128 {
        let overhead = 40 + 64 + 64; // key prefix, hash, value length
        near_sdk::json_types::U128((bytes + overhead) as u128 * env::storage_byte_cost().as_yoctonear())
    }

    pub fn stats(&self) -> near_sdk::serde_json::Value {
        json!({ "stored": self.stored })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    /// A minimal PNG header: signature, then an IHDR claiming `w` × `h`.
    fn png(w: u32, h: u32, padding: usize) -> Vec<u8> {
        let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        out.extend_from_slice(b"IHDR");
        out.extend_from_slice(&w.to_be_bytes());
        out.extend_from_slice(&h.to_be_bytes());
        out.extend(std::iter::repeat_n(7u8, padding));
        out
    }

    fn ctx(deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id("alice.near".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit));
        testing_env!(b.build());
    }

    const ONE_NEAR: u128 = 10u128.pow(24);

    #[test]
    fn a_sheet_is_stored_under_its_hash_and_read_back() {
        ctx(0);
        let mut art = Art::new();
        let sheet = png(1536, 1872, 1000);
        ctx(ONE_NEAR);
        let hash = art.put(sheet.clone().into());
        assert_eq!(hash.len(), 64);
        let back: Vec<u8> = art.get(hash.clone()).unwrap().into();
        assert_eq!(back, sheet);
        assert!(art.has(hash));
    }

    #[test]
    fn storing_the_same_sheet_twice_keeps_one_copy() {
        ctx(0);
        let mut art = Art::new();
        ctx(ONE_NEAR);
        let a = art.put(png(1536, 1872, 10).into());
        let b = art.put(png(1536, 1872, 10).into());
        assert_eq!(a, b);
        assert_eq!(art.stats()["stored"], 1);
    }

    #[test]
    #[should_panic(expected = "Attach")]
    fn storage_has_to_be_paid_for() {
        ctx(0);
        let mut art = Art::new();
        art.put(png(1536, 1872, 5000).into());
    }

    #[test]
    fn only_pet_sheets_are_accepted() {
        assert_eq!(sheet_error(&png(1536, 1872, 0)), None);
        assert!(sheet_error(&png(1537, 1872, 0)).unwrap().contains("divide by 8"));
        assert!(sheet_error(&png(128, 144, 0)).unwrap().contains("256"));
        assert_eq!(sheet_error(b"GIF89a not a png at all"), Some("That is not a PNG"));
        assert!(sheet_error(&png(1536, 1872, MAX_SHEET_BYTES)).unwrap().contains("600 KB"));
    }
}
