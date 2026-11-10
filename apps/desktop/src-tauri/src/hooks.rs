use std::net::SocketAddr;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Html,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// The hook server.
///
/// Coding agents already have hooks that fire on every tool call, so the pet
/// does not need to watch processes or read logs: the agent posts here and the
/// window reacts. One endpoint, one shape, any agent — Claude Code, Codex, a
/// shell script, `curl`.
///
/// Bound to loopback on purpose, and that is the whole security model: nothing
/// here authenticates, because nothing here can be reached from off the
/// machine. Do not change the bind address without adding one.
pub const HOOK_PORT: u16 = 7777;

/// What the pet is told about. Matches `AgentEvent` in `@joygotchi/pet`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AgentEvent {
    ToolStart { tool: String },
    ToolEnd { tool: String, ok: bool },
    Prompt,
    Idle,
    /// From the game rather than from a coding agent: feeding a pet on the web
    /// should make the pet on the desktop react, and it comes in the same way
    /// so there is one door.
    Game { what: GameEvent },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GameEvent {
    Fed,
    Battled,
}

#[derive(Serialize)]
struct Health {
    ok: bool,
    app: &'static str,
    port: u16,
}

async fn health() -> Json<Health> {
    Json(Health {
        ok: true,
        app: "joygotchi-desktop",
        port: HOOK_PORT,
    })
}

async fn event(
    State(app): State<AppHandle>,
    Json(event): Json<AgentEvent>,
) -> (StatusCode, Json<serde_json::Value>) {
    /*
     * Say what arrived. The handler used to emit and nothing else, which
     * meant there was no way to tell a hook that never fired from one that
     * fired into a window that ignored it — and "is it wired up?" is the
     * question this server exists to be asked.
     */
    println!("[hook] {}", serde_json::to_string(&event).unwrap_or_default());

    // Emitting is the whole handler: the window decides what the event looks
    // like, so the agent is never kept waiting on an animation or on NEAR AI.
    if let Err(error) = app.emit("agent-event", &event) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": error.to_string() })),
        );
    }
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

/// What the wallet puts on the redirect after a sign-in.
#[derive(Debug, Deserialize)]
pub struct WalletCallback {
    pub account_id: Option<String>,
    pub public_key: Option<String>,
    /// Present but unused: every key on the account, which we do not need.
    #[allow(dead_code)]
    pub all_keys: Option<String>,
    pub error_code: Option<String>,
}

/// Where the wallet sends the browser back to.
///
/// The loopback server was already here for agent hooks, so connecting a
/// wallet needs no deep link, no custom URL scheme and no registration with
/// the operating system — the wallet just redirects to a port on this machine
/// and the window hears about it.
///
/// A refusal is reported as a refusal rather than left to time out: closing
/// the wallet tab is a normal thing to do.
async fn wallet_callback(
    State(app): State<AppHandle>,
    Query(params): Query<WalletCallback>,
) -> Html<&'static str> {
    // Logged because the failure everybody hits is silent: the browser either
    // reached this machine or it did not, and from inside the window those
    // look identical.
    match (params.account_id, params.public_key, params.error_code) {
        (Some(account_id), Some(public_key), _) => {
            println!("joygotchi: wallet callback for {account_id}");
            match app.emit(
                "wallet-connected",
                serde_json::json!({ "accountId": account_id, "publicKey": public_key }),
            ) {
                Ok(()) => println!("joygotchi: told the window"),
                Err(error) => eprintln!("joygotchi: could not tell the window: {error}"),
            }
            Html(CONNECTED_PAGE)
        }
        (_, _, Some(code)) => {
            println!("joygotchi: wallet callback refused ({code})");
            let _ = app.emit("wallet-cancelled", serde_json::json!({}));
            Html(CANCELLED_PAGE)
        }
        _ => {
            println!("joygotchi: wallet callback with no account and no error");
            let _ = app.emit("wallet-cancelled", serde_json::json!({}));
            Html(CANCELLED_PAGE)
        }
    }
}

const CONNECTED_PAGE: &str = r#"<!doctype html><meta charset=utf-8>
<title>JOYGOTCHI</title>
<body style="background:#0b0d10;color:#e7ebf0;font:14px ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
<p style="color:#b6f36b;font-size:18px">Connected.</p>
<p style="color:#8b95a3">Your pet is waiting. You can close this tab.</p>
</div>"#;

const CANCELLED_PAGE: &str = r#"<!doctype html><meta charset=utf-8>
<title>JOYGOTCHI</title>
<body style="background:#0b0d10;color:#e7ebf0;font:14px ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
<p style="color:#f3a66b;font-size:18px">Not connected.</p>
<p style="color:#8b95a3">Nothing was granted. You can close this tab and try again.</p>
</div>"#;

/// What the gallery reports after signing one transaction with the wallet.
#[derive(Debug, Deserialize)]
pub struct ActCallback {
    pub method: Option<String>,
    pub tx_hash: Option<String>,
    pub error: Option<String>,
}

/// Where a wallet-signed action reports back to.
///
/// Separate from the wallet callback because it means something different: a
/// grant happens once, an action happens whenever the player stakes a pet.
/// Both come home the same way, over loopback, for the same reason.
async fn act_callback(
    State(app): State<AppHandle>,
    Query(params): Query<ActCallback>,
) -> Html<&'static str> {
    let method = params.method.unwrap_or_else(|| "action".into());

    match (params.tx_hash, params.error) {
        (Some(hash), _) => {
            println!("joygotchi: {method} signed, tx {hash}");
            let _ = app.emit(
                "act-done",
                serde_json::json!({ "method": method, "txHash": hash }),
            );
            Html(ACTED_PAGE)
        }
        (None, error) => {
            let reason = error.unwrap_or_else(|| "cancelled".into());
            println!("joygotchi: {method} did not go through ({reason})");
            let _ = app.emit(
                "act-failed",
                serde_json::json!({ "method": method, "error": reason }),
            );
            Html(NOT_ACTED_PAGE)
        }
    }
}

const ACTED_PAGE: &str = r#"<!doctype html><meta charset=utf-8>
<title>JOYGOTCHI</title>
<body style="background:#0b0d10;color:#e7ebf0;font:14px ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
<p style="color:#b6f36b;font-size:18px">Done.</p>
<p style="color:#8b95a3">Back to your pet. You can close this tab.</p>
</div>"#;

const NOT_ACTED_PAGE: &str = r#"<!doctype html><meta charset=utf-8>
<title>JOYGOTCHI</title>
<body style="background:#0b0d10;color:#e7ebf0;font:14px ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
<p style="color:#f3a66b;font-size:18px">Nothing happened.</p>
<p style="color:#8b95a3">Your pet is unchanged. You can close this tab.</p>
</div>"#;

pub fn router(app: AppHandle) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/event", post(event))
        .route("/wallet-callback", get(wallet_callback))
        .route("/act-callback", get(act_callback))
        .with_state(app)
}

/// Start the server. A port already in use is reported, not fatal: a second
/// copy of the app should still show your pet.
pub async fn serve(app: AppHandle) {
    let addr = SocketAddr::from(([127, 0, 0, 1], HOOK_PORT));

    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            if let Err(error) = axum::serve(listener, router(app)).await {
                eprintln!("joygotchi: hook server stopped: {error}");
            }
        }
        Err(error) => {
            eprintln!(
                "joygotchi: could not listen on {addr} ({error}). \
                 The pet still runs; agent events will not reach it."
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_events_an_agent_sends() {
        let start: AgentEvent =
            serde_json::from_str(r#"{"kind":"tool-start","tool":"Bash"}"#).unwrap();
        assert!(matches!(start, AgentEvent::ToolStart { ref tool } if tool == "Bash"));

        let end: AgentEvent =
            serde_json::from_str(r#"{"kind":"tool-end","tool":"Edit","ok":false}"#).unwrap();
        assert!(matches!(end, AgentEvent::ToolEnd { ok: false, .. }));

        let prompt: AgentEvent = serde_json::from_str(r#"{"kind":"prompt"}"#).unwrap();
        assert!(matches!(prompt, AgentEvent::Prompt));
    }

    #[test]
    fn parses_the_game_events_the_web_app_sends() {
        let fed: AgentEvent = serde_json::from_str(r#"{"kind":"game","what":"fed"}"#).unwrap();
        assert!(matches!(fed, AgentEvent::Game { what: GameEvent::Fed }));

        let battled: AgentEvent =
            serde_json::from_str(r#"{"kind":"game","what":"battled"}"#).unwrap();
        assert!(matches!(battled, AgentEvent::Game { what: GameEvent::Battled }));

        // A `game` with no `what` is a caller bug, not a pet that does nothing.
        assert!(serde_json::from_str::<AgentEvent>(r#"{"kind":"game"}"#).is_err());
    }

    #[test]
    fn refuses_an_event_it_does_not_understand() {
        // A typo in someone's hook script should fail loudly at the edge
        // rather than reach the window as an event with no kind.
        assert!(serde_json::from_str::<AgentEvent>(r#"{"kind":"toolstart"}"#).is_err());
        assert!(serde_json::from_str::<AgentEvent>(r#"{"kind":"tool-start"}"#).is_err());
    }

    #[test]
    fn round_trips_back_to_the_shape_the_frontend_expects() {
        let json = serde_json::to_string(&AgentEvent::ToolEnd {
            tool: "Read".into(),
            ok: true,
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"tool-end","tool":"Read","ok":true}"#);
    }
}
