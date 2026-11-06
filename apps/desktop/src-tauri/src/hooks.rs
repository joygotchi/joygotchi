use std::net::SocketAddr;

use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
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

/// What an agent tells us. Matches `AgentEvent` in `@joygotchi/pet`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AgentEvent {
    ToolStart { tool: String },
    ToolEnd { tool: String, ok: bool },
    Prompt,
    Idle,
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

pub fn router(app: AppHandle) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/event", post(event))
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
