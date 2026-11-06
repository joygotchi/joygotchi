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

        std::env::set_var("JOYGOTCHI_HOME", &root);
        let pets = installed_pets();
        std::env::remove_var("JOYGOTCHI_HOME");

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

        std::env::set_var("JOYGOTCHI_HOME", &root);
        let pets = installed_pets();
        std::env::remove_var("JOYGOTCHI_HOME");

        assert_eq!(pets.len(), 1);
        assert_eq!(pets[0].package.display_name, "GOOD");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_machine_is_an_empty_list_not_an_error() {
        std::env::set_var("JOYGOTCHI_HOME", std::env::temp_dir().join("jg-does-not-exist"));
        let pets = installed_pets();
        std::env::remove_var("JOYGOTCHI_HOME");
        assert!(pets.is_empty());
    }
}
