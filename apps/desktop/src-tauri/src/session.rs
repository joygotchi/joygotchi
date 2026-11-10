use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// The signing session: an account and the limited keys that act for it.
///
/// Each key is a NEAR **function-call access key**, which the player's wallet
/// adds to their account once. The protocol guarantees what it can do better
/// than any check here could: one contract, the methods named at sign-in, and
/// no attached NEAR ever — which is why minting still goes through the wallet
/// and feeding does not.
///
/// A NEAR account's access keys are a map from public key to permission, so a
/// single public key carries exactly one permission — granting it for a second
/// contract does nothing, silently. Playing from the desktop reaches the lab,
/// the game and the accessory contracts, so it takes three keypairs.
///
/// # Where the secrets live
///
/// In a file beside this session, mode 0600, chosen over the operating
/// system's keychain with the trade understood: any process running as this
/// user can read it. The keychain was stronger and asked permission on every
/// rebuild, which in practice means a prompt several times an hour.
///
/// What is actually at risk is bounded, and that is what makes the trade
/// reasonable rather than lazy. These keys cannot attach a deposit, cannot
/// transfer a pet, and cannot call anything outside the method lists in
/// `@joygotchi/pet`. The worst a copy buys is somebody else feeding your pet
/// and spending its credits. The account's real keys are in a wallet this app
/// never sees.
///
/// Still never the webview's `localStorage`: that is reachable by anything
/// that ever executes inside the window, which is a much larger surface than
/// "a process already running as you". The secret is reachable only through
/// `sign_bytes`, and the window gets signatures, not keys.
/// The file, next to `session.json` in the app's own data directory.
const KEYS_FILE: &str = "keys.json";

/// Which of the three keys a call needs.
///
/// A name rather than a boolean: there were two contracts and now there are
/// three, and `on_game: bool` has no room for the third. The webview sends
/// this string, and anything it does not recognise is the lab — the default
/// a mistake should fall to, since that key is the most restricted.
pub fn slot_name(slot: &str) -> &'static str {
    match slot {
        "game" => "game",
        "accessory" => "accessory",
        _ => "lab",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub account_id: String,
    pub public_key: String,
    /// The contract the key may call. One, by protocol.
    pub contract_id: String,
    /// The game contract, reached by a second key. Absent on older sessions.
    #[serde(default)]
    pub game_contract_id: Option<String>,
    /// The accessory contract, reached by a third. Also absent on older
    /// sessions, which is why both are optional: the file on disk outlives
    /// the version of the app that wrote it.
    #[serde(default)]
    pub accessory_contract_id: Option<String>,
    #[serde(default)]
    pub accessory_public_key: Option<String>,
    /// That second key's public half. One public key carries one permission,
    /// so reaching two contracts takes two keypairs — not one granted twice.
    #[serde(default)]
    pub game_public_key: Option<String>,
    /// The methods it may call on it.
    pub method_names: Vec<String>,
    /// Unix seconds. Not enforced by the chain — see `is_expired`.
    pub expires_at: u64,
}

type Keys = BTreeMap<String, String>;

fn keys_path(app_dir: &Path) -> std::path::PathBuf {
    app_dir.join(KEYS_FILE)
}

fn read_keys(app_dir: &Path) -> Keys {
    std::fs::read_to_string(keys_path(app_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Write the file back, readable by this user and nobody else.
///
/// The permissions are set before the secrets go in. Writing first and
/// chmod-ing after leaves a window, however short, where the file is
/// world-readable — and a window is all it takes.
fn write_keys(app_dir: &Path, keys: &Keys) -> Result<(), String> {
    std::fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
    let path = keys_path(app_dir);

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let json = serde_json::to_string(keys).map_err(|e| e.to_string())?;
        return file.write_all(json.as_bytes()).map_err(|e| e.to_string());
    }

    #[cfg(not(unix))]
    {
        let json = serde_json::to_string(keys).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }
}

impl Session {
    /// Sessions are time-bounded the way every other session-key system is,
    /// but NEAR access keys have no expiry of their own: nothing on chain
    /// stops this key after the date below. Expiry here means the app refuses
    /// to use it and tells the player to remove it in their wallet, which is
    /// the only place it can actually be revoked.
    pub fn is_expired(&self, now_secs: u64) -> bool {
        self.expires_at != 0 && now_secs >= self.expires_at
    }
}

/// Where the session's public half is kept. Readable, so it goes in a plain
/// file next to the app's data rather than taking a keychain slot.
pub fn save_session(app_dir: &std::path::Path, session: &Session) -> Result<(), String> {
    std::fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    std::fs::write(app_dir.join("session.json"), json).map_err(|e| e.to_string())
}

pub fn load_session(app_dir: &std::path::Path) -> Option<Session> {
    let raw = std::fs::read_to_string(app_dir.join("session.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn clear_session(app_dir: &std::path::Path) -> Result<(), String> {
    let path = app_dir.join("session.json");
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    // A session with no keys is not a session; drop all of it or none.
    let keys = keys_path(app_dir);
    if keys.exists() {
        std::fs::remove_file(&keys).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn save_secret_key(app_dir: &Path, secret: &str) -> Result<(), String> {
    save_secret_key_for(app_dir, "lab", secret)
}

/// Store one key by slot. Three entries in one file.
pub fn save_secret_key_for(app_dir: &Path, slot: &str, secret: &str) -> Result<(), String> {
    let mut keys = read_keys(app_dir);
    keys.insert(slot_name(slot).to_string(), secret.to_string());
    write_keys(app_dir, &keys)
}

pub fn load_secret_key_for(app_dir: &Path, slot: &str) -> Option<String> {
    read_keys(app_dir).get(slot_name(slot)).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(expires_at: u64) -> Session {
        Session {
            account_id: "alice.testnet".into(),
            public_key: "ed25519:abc".into(),
            contract_id: "jg-stake-5656.testnet".into(),
            game_contract_id: Some("jg-game-5656.testnet".into()),
            game_public_key: Some("ed25519:def".into()),
            accessory_contract_id: Some("jg-acc-5656.testnet".into()),
            accessory_public_key: Some("ed25519:ghi".into()),
            method_names: vec!["spend_credits".into()],
            expires_at,
        }
    }

    #[test]
    fn an_expiry_of_zero_means_no_expiry() {
        assert!(!session(0).is_expired(u64::MAX));
    }

    #[test]
    fn expires_on_the_second_it_says() {
        let s = session(1_000);
        assert!(!s.is_expired(999));
        assert!(s.is_expired(1_000));
        assert!(s.is_expired(1_001));
    }

    #[test]
    fn round_trips_through_the_json_the_webview_reads() {
        let json = serde_json::to_string(&session(42)).unwrap();
        // camelCase, because the other side of this is TypeScript.
        assert!(json.contains("\"accountId\""), "{json}");
        assert!(json.contains("\"methodNames\""), "{json}");
        // The game key is its own keypair, and the session has to carry it:
        // one public key can only ever hold one contract's permission.
        assert!(json.contains("\"gamePublicKey\""), "{json}");
        // The game key is a separate keypair, and the session has to say so —
        // one public key can only ever carry one contract's permission.
        assert!(json.contains("\"gamePublicKey\""), "{json}");

        let back: Session = serde_json::from_str(&json).unwrap();
        assert_eq!(back.account_id, "alice.testnet");
        assert_eq!(back.expires_at, 42);
    }

    #[test]
    fn an_older_session_without_a_game_key_still_loads() {
        let json = r#"{
          "accountId": "alice.testnet",
          "publicKey": "ed25519:abc",
          "contractId": "jg-stake-5656.testnet",
          "methodNames": ["spend_credits"],
          "expiresAt": 0
        }"#;
        let session: Session = serde_json::from_str(json).unwrap();
        assert_eq!(session.account_id, "alice.testnet");
        assert!(session.game_public_key.is_none());
    }

    #[test]
    fn keys_round_trip_per_slot_and_are_readable_only_by_this_user() {
        let dir = std::env::temp_dir().join(format!("jg-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(load_secret_key_for(&dir, "lab").is_none());

        save_secret_key_for(&dir, "lab", "ed25519:lab").unwrap();
        save_secret_key_for(&dir, "game", "ed25519:game").unwrap();
        save_secret_key_for(&dir, "accessory", "ed25519:acc").unwrap();

        // Three slots, kept apart: one overwriting another would sign for
        // the wrong contract and the node, not the contract, would refuse.
        assert_eq!(load_secret_key_for(&dir, "lab").unwrap(), "ed25519:lab");
        assert_eq!(load_secret_key_for(&dir, "game").unwrap(), "ed25519:game");
        assert_eq!(load_secret_key_for(&dir, "accessory").unwrap(), "ed25519:acc");

        // An unknown slot falls to the lab key, which is the most restricted
        // of the three — the safest place for a mistake to land.
        assert_eq!(load_secret_key_for(&dir, "nonsense").unwrap(), "ed25519:lab");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(KEYS_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "secrets must not be readable by other users");
        }

        clear_session(&dir).unwrap();
        assert!(load_secret_key_for(&dir, "lab").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_saved_session_comes_back_and_a_cleared_one_does_not() {
        let dir = std::env::temp_dir().join(format!("jg-session-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(load_session(&dir).is_none());
        save_session(&dir, &session(7)).unwrap();
        assert_eq!(load_session(&dir).unwrap().expires_at, 7);

        clear_session(&dir).unwrap();
        assert!(load_session(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Sign bytes with a session key, without the key leaving this process.
///
/// The webview builds the transaction and asks for a signature over its hash;
/// it never holds the secret. That is the whole reason the keys are in the
/// keychain rather than in the window's `localStorage`: localStorage is a file
/// on disk that any process running as this user can read, and anything that
/// ever executes inside the webview can read it with one line. Here the secret
/// is reachable only through this function.
///
/// A NEAR secret key is `ed25519:<base58>` over 64 bytes — the 32-byte seed
/// followed by the public key. Only the seed goes into the signer; the rest is
/// checked so a truncated or pasted-wrong key fails here rather than as an
/// invalid signature the chain rejects.
pub fn sign_with_session_key(secret: &str, message: &[u8]) -> Result<Vec<u8>, String> {
    use ed25519_dalek::{Signer as _, SigningKey};

    let encoded = secret.strip_prefix("ed25519:").unwrap_or(secret);
    let bytes = bs58::decode(encoded)
        .into_vec()
        .map_err(|_| "the stored key is not base58".to_string())?;

    if bytes.len() != 64 {
        return Err(format!(
            "expected a 64-byte NEAR secret key, found {} bytes",
            bytes.len()
        ));
    }

    let seed: [u8; 32] = bytes[..32]
        .try_into()
        .map_err(|_| "could not read the key's seed".to_string())?;

    Ok(SigningKey::from_bytes(&seed).sign(message).to_bytes().to_vec())
}

#[cfg(test)]
mod signing_tests {
    use super::*;

    /// A known NEAR-format key, its public half, and a signature over "hello"
    /// checked with the public key — so this test fails if the seed is read
    /// from the wrong half of the 64 bytes.
    #[test]
    fn signs_with_the_seed_half_of_a_near_secret_key() {
        use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};

        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let verifying: VerifyingKey = signing.verifying_key();

        // NEAR stores seed || public, which is what the wallet hands over.
        let mut combined = Vec::with_capacity(64);
        combined.extend_from_slice(&[7u8; 32]);
        combined.extend_from_slice(verifying.as_bytes());
        let encoded = format!("ed25519:{}", bs58::encode(&combined).into_string());

        let sig = sign_with_session_key(&encoded, b"hello").unwrap();
        let sig = Signature::from_slice(&sig).unwrap();

        verifying.verify(b"hello", &sig).expect("the signature should verify");
    }

    #[test]
    fn refuses_a_key_of_the_wrong_length_rather_than_signing_rubbish() {
        let short = format!("ed25519:{}", bs58::encode([1u8; 32]).into_string());
        let error = sign_with_session_key(&short, b"x").unwrap_err();
        assert!(error.contains("64-byte"), "{error}");

        assert!(sign_with_session_key("ed25519:not-base58-0OIl", b"x").is_err());
    }
}
