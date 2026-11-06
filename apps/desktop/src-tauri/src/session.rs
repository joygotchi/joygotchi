use keyring::Entry;
use serde::{Deserialize, Serialize};

/// The signing session: an account and the limited key that acts for it.
///
/// The key is a NEAR **function-call access key**, which the player's wallet
/// adds to their account once. The protocol then guarantees what it can do
/// better than any check here could: one contract, the methods named at
/// sign-in, and no attached NEAR ever — not even the one yoctoNEAR that
/// `stake_pet` requires, which is exactly why staking still goes through the
/// wallet.
///
/// It lives in the operating system's keychain rather than in the webview's
/// localStorage, because localStorage is a file any process running as this
/// user can read. The webview asks for it at signing time and never stores it.
const SERVICE: &str = "dev.joygotchi.desktop";
const KEY_ENTRY: &str = "session-secret-key";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub account_id: String,
    pub public_key: String,
    /// The contract the key may call. One, by protocol.
    pub contract_id: String,
    /// The methods it may call on it.
    pub method_names: Vec<String>,
    /// Unix seconds. Not enforced by the chain — see `is_expired`.
    pub expires_at: u64,
}

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|error| format!("keychain unavailable: {error}"))
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
    // A session with no key is not a session; drop both or neither.
    let _ = entry(KEY_ENTRY).and_then(|e| e.delete_credential().map_err(|x| x.to_string()));
    Ok(())
}

pub fn save_secret_key(secret: &str) -> Result<(), String> {
    entry(KEY_ENTRY)?
        .set_password(secret)
        .map_err(|error| format!("could not write to the keychain: {error}"))
}

pub fn load_secret_key() -> Option<String> {
    entry(KEY_ENTRY).ok()?.get_password().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(expires_at: u64) -> Session {
        Session {
            account_id: "alice.testnet".into(),
            public_key: "ed25519:abc".into(),
            contract_id: "jg-stake-5656.testnet".into(),
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

        let back: Session = serde_json::from_str(&json).unwrap();
        assert_eq!(back.account_id, "alice.testnet");
        assert_eq!(back.expires_at, 42);
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
