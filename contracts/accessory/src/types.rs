use near_sdk::json_types::U128;
use near_sdk::near;

/// Something that can be minted, and what it costs.
///
/// Kinds are stored rather than compiled in, which is the difference between
/// adding a hat and redeploying a contract. The game's own `CATEGORIES` is a
/// two-element `const` and that has been the blocker on letting anyone else
/// contribute art; this does not repeat it.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Kind {
    pub slug: String,
    pub name: String,
    /// Price in yoctoNEAR.
    pub price: U128,
    /// 0 means no cap. A cap is what makes one hat rarer than another, so it
    /// is set when the kind is added and never afterwards.
    pub supply_cap: u32,
    pub minted: u32,
    /// Where the art lives. A URL rather than bytes: the image is served by
    /// the gallery, and a contract is an expensive place to keep a PNG.
    pub art: String,
}

impl Kind {
    pub fn sold_out(&self) -> bool {
        self.supply_cap != 0 && self.minted >= self.supply_cap
    }
}

/// A token, with the two things the app asks about it.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct WornView {
    pub token_id: String,
    pub owner_id: near_sdk::AccountId,
    pub kind: String,
    pub art: String,
    /// The pet wearing it, if any.
    pub pet_id: Option<u64>,
}
