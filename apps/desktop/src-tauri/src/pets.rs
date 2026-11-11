use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// A pet as the CLI wrote it to disk.
///
/// Only the fields the window needs are typed; `#[serde(default)]` on the rest
/// means a `pet.json` from a newer CLI still loads rather than taking the whole
/// listing down with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPackage {
    pub format: String,
    pub slug: String,
    pub display_name: String,
    pub pet_id: u64,
    pub install_code: String,
    pub kind: String,
    pub rarity: String,
    #[serde(default)]
    pub level: u32,
    #[serde(default)]
    pub star: u32,
    pub chain: ChainRef,
    pub states: std::collections::BTreeMap<String, String>,
    /// A nine-row sprite atlas, on a v2 package. Absent on the GIF ones,
    /// which is every pet installed before atlases existed — hence the
    /// `Option` and the `skip_serializing_if`, so an old `pet.json` still
    /// round-trips through here unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub atlas: Option<Atlas>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sprite_version: Option<u8>,
}

/// Where the frames are on the sheet. Mirrors `Atlas` in `@joygotchi/pet`;
/// nothing here reads it, it only has to survive the trip to the window.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Atlas {
    pub sheet: String,
    pub columns: u32,
    pub rows: u32,
    pub frame: Frame,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainRef {
    pub network: String,
    pub contract: String,
    pub owner: String,
}

/// A pet plus where it lives, which is what the window needs to show its art.
#[derive(Debug, Clone, Serialize)]
pub struct InstalledPet {
    #[serde(flatten)]
    pub package: PetPackage,
    /// Absolute path to the pet's folder, for the asset protocol.
    pub directory: String,
}

pub fn pets_root() -> PathBuf {
    if let Ok(custom) = std::env::var("JOYGOTCHI_HOME") {
        return PathBuf::from(custom);
    }
    dirs_home().join(".joygotchi").join("pets")
}

fn dirs_home() -> PathBuf {
    // `$HOME` on Unix, `%USERPROFILE%` on Windows. Avoids a crate for two
    // environment variables.
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Every pet installed on this machine, sorted by id.
///
/// A folder that is not a pet, or one the CLI was halfway through writing, is
/// skipped rather than returned as an error: one bad folder should not empty
/// the Pets menu.
pub fn installed_pets() -> Vec<InstalledPet> {
    let root = pets_root();
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };

    let mut pets: Vec<InstalledPet> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let directory = entry.path();
            let raw = fs::read_to_string(directory.join("pet.json")).ok()?;
            let package: PetPackage = serde_json::from_str(&raw).ok()?;
            if package.format != "joygotchi/1" {
                return None;
            }
            Some(InstalledPet {
                package,
                directory: directory.to_string_lossy().into_owned(),
            })
        })
        .collect();

    pets.sort_by_key(|pet| pet.package.pet_id);
    pets
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `installed_pets` with `JOYGOTCHI_HOME` pointed at `home`.
    ///
    /// The variable is process-wide and the tests run in parallel, so one
    /// test's home leaked into another's read and failed it now and then on
    /// CI. The lock makes each set-read-unset happen alone.
    fn pets_in(home: impl AsRef<std::path::Path>) -> Vec<InstalledPet> {
        static HOME: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _alone = HOME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::set_var("JOYGOTCHI_HOME", home.as_ref());
        let pets = installed_pets();
        std::env::remove_var("JOYGOTCHI_HOME");
        pets
    }
    use std::path::Path;

    fn write_pet(root: &Path, slug: &str, body: &str) {
        let dir = root.join(slug);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("pet.json"), body).unwrap();
    }

    fn pet_json(pet_id: u64, name: &str) -> String {
        format!(
            r#"{{
              "format": "joygotchi/1",
              "slug": "{name}-{pet_id}",
              "displayName": "{name}",
              "petId": {pet_id},
              "installCode": "jg1_test",
              "kind": "blackdragon",
              "rarity": "common",
              "level": 1,
              "star": 0,
              "chain": {{ "network": "testnet", "contract": "game.test", "owner": "a.test" }},
              "states": {{ "idle": "blackdragon/1.gif" }}
            }}"#
        )
    }

    #[test]
    fn reads_pets_and_sorts_them_by_id() {
        let root = std::env::temp_dir().join(format!("jg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        write_pet(&root, "b-9", &pet_json(9, "B"));
        write_pet(&root, "a-2", &pet_json(2, "A"));

        let pets = pets_in(&root);

        assert_eq!(pets.len(), 2);
        assert_eq!(pets[0].package.pet_id, 2);
        assert_eq!(pets[1].package.pet_id, 9);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_what_is_not_a_pet_instead_of_returning_nothing() {
        let root = std::env::temp_dir().join(format!("jg-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        write_pet(&root, "good-1", &pet_json(1, "GOOD"));
        write_pet(&root, "broken", "{ not json");
        write_pet(&root, "alien", r#"{"format":"petdex/1"}"#);
        fs::create_dir_all(root.join("empty")).unwrap();

        let pets = pets_in(&root);

        assert_eq!(pets.len(), 1);
        assert_eq!(pets[0].package.display_name, "GOOD");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_v2_package_keeps_its_atlas_on_the_way_to_the_window() {
        /*
         * The seam nothing else covers. The window decides whether to draw
         * sprite rows or a still image by whether `atlas` arrived, and this
         * struct is the only thing between `pet.json` and that decision — a
         * field missing here is a pet that silently stops animating, with
         * every TypeScript test still passing.
         */
        let root = std::env::temp_dir().join("jg-atlas-test");
        let _ = fs::remove_dir_all(&root);
        write_pet(
            &root,
            "wyvern-9",
            r#"{
              "format":"joygotchi/1","slug":"wyvern-9","displayName":"WYVERN",
              "petId":9,"installCode":"jg1_x","kind":"wyvern","rarity":"common",
              "level":1,"star":0,
              "chain":{"network":"testnet","contract":"c.testnet","owner":"a.testnet"},
              "states":{"idle":"spritesheet.png"},
              "spriteVersion":2,
              "atlas":{"sheet":"spritesheet.png","columns":8,"rows":9,
                       "frame":{"width":192,"height":208}}
            }"#,
        );

        let pets = pets_in(&root);

        assert_eq!(pets.len(), 1);
        let atlas = pets[0].package.atlas.as_ref().expect("the atlas was dropped");
        assert_eq!(atlas.columns, 8);
        assert_eq!(atlas.rows, 9);
        assert_eq!(atlas.frame.width, 192);
        assert_eq!(atlas.frame.height, 208);
        assert_eq!(pets[0].package.sprite_version, Some(2));

        // And it survives being serialised back out, which is the actual
        // trip: `list_pets` returns JSON to the window, not this struct.
        let sent = serde_json::to_string(&pets[0]).unwrap();
        assert!(sent.contains("\"atlas\""), "atlas missing from {sent}");
        assert!(sent.contains("\"spriteVersion\":2"), "version missing from {sent}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_v1_package_says_nothing_about_an_atlas() {
        // Every pet installed before today is v1, and `skip_serializing_if`
        // is what keeps those `pet.json` files round-tripping unchanged.
        let root = std::env::temp_dir().join("jg-v1-test");
        let _ = fs::remove_dir_all(&root);
        write_pet(
            &root,
            "kuro-6",
            r#"{
              "format":"joygotchi/1","slug":"kuro-6","displayName":"KURO",
              "petId":6,"installCode":"jg1_y","kind":"greendragon","rarity":"common",
              "level":2,"star":0,
              "chain":{"network":"testnet","contract":"c.testnet","owner":"a.testnet"},
              "states":{"idle":"greendragon/2.gif"}
            }"#,
        );

        let pets = pets_in(&root);

        assert_eq!(pets.len(), 1);
        assert!(pets[0].package.atlas.is_none());
        let sent = serde_json::to_string(&pets[0]).unwrap();
        assert!(!sent.contains("atlas"), "a v1 pet grew an atlas: {sent}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_machine_is_an_empty_list_not_an_error() {
        let pets = pets_in(std::env::temp_dir().join("jg-does-not-exist"));
        assert!(pets.is_empty());
    }
}
