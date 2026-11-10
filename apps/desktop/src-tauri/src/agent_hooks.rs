//! Wiring a coding agent to the pet.
//!
//! The hook server has always been there and the pet has always known how to
//! react — what was missing is the one step that makes it happen: telling the
//! agent to post. The README gave a `curl` to paste, which means the feature
//! worked for whoever read the README and for nobody else.
//!
//! Claude Code runs a command on each hook event and hands it the event as
//! JSON on stdin. That command is a small script this writes next to the
//! app's own data, so the entry in `settings.json` stays one line and the
//! awkward part — reading stdin, surviving a pet that is not running — lives
//! somewhere it can be read and fixed.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::hooks::HOOK_PORT;

/// The four events worth a reaction, and what the pet is told for each.
///
/// `Stop` rather than a timer for idle: the agent knows when it has finished
/// talking, and a timer in the app would be guessing at it.
const EVENTS: [(&str, &str); 4] = [
    ("PreToolUse", "tool-start"),
    ("PostToolUse", "tool-end"),
    ("UserPromptSubmit", "prompt"),
    ("Stop", "idle"),
];

/// Marks the entries this app owns, so installing twice replaces rather than
/// stacks, and uninstalling takes out only what was put in.
const TAG: &str = "joygotchi";

fn script_path(app_dir: &Path) -> PathBuf {
    app_dir.join("agent-hook.sh")
}

/// A path the agent's shell will read as one word.
///
/// The app's own data directory is `~/Library/Application Support/...` on
/// macOS, so the command string contains a space and an unquoted path runs
/// `/Users/you/Library/Application` with arguments. The hooks installed, the
/// settings looked right, and nothing ever fired.
///
/// Single quotes, with the only character they cannot hold — a single quote —
/// spliced in the usual way.
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
}

/// The forwarder.
///
/// Three rules, all of them about never being the reason a tool call fails:
/// a one-second timeout, every error swallowed, and `exit 0` whatever
/// happened. A desktop pet must not be able to break somebody's editor.
fn script_body() -> String {
    format!(
        r#"#!/bin/sh
# Forward one coding-agent event to the JOYGOTCHI pet. Installed by the app.
#
# Never fails the agent: one second at most, errors swallowed, exit 0 always.
# A pet that is not running, or a port in use by something else, has to look
# exactly like nothing happening.
kind="$1"
payload=$(/usr/bin/python3 -c '
import json, sys
kind = sys.argv[1]
try:
    hook = json.load(sys.stdin)
except Exception:
    hook = {{}}
tool = hook.get("tool_name") or "Bash"
if kind == "tool-start":
    out = {{"kind": "tool-start", "tool": tool}}
elif kind == "tool-end":
    # The pet waves on success and slumps on failure. Claude Code reports a
    # blocked or errored call through these; anything unrecognised counts as
    # fine, because a pet that looks upset at working code is worse than one
    # that misses a failure.
    response = hook.get("tool_response")
    ok = True
    if isinstance(response, dict):
        ok = not (response.get("is_error") or response.get("error"))
    out = {{"kind": "tool-end", "tool": tool, "ok": bool(ok)}}
else:
    out = {{"kind": kind}}
print(json.dumps(out))
' "$kind" 2>/dev/null)

[ -n "$payload" ] && curl -s -m 1 -X POST "http://127.0.0.1:{port}/event" \
  -H 'content-type: application/json' -d "$payload" >/dev/null 2>&1
exit 0
"#,
        port = HOOK_PORT
    )
}

fn settings_path() -> Option<PathBuf> {
    dirs_home().map(|home| home.join(".claude").join("settings.json"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Whether this app's hooks are in the agent's settings right now.
pub fn installed() -> bool {
    let Some(path) = settings_path() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(settings) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    EVENTS.iter().all(|(event, _)| {
        settings
            .get("hooks")
            .and_then(|hooks| hooks.get(event))
            .and_then(Value::as_array)
            .is_some_and(|entries| entries.iter().any(is_ours_and_works))
    })
}

/// Whether this entry is one of ours, broken ones included.
///
/// Used when replacing and removing, where a version that cannot run still
/// has to be found and taken out.
fn is_ours(entry: &Value) -> bool {
    command_of(entry).is_some_and(|command| command.contains(TAG))
}

/// Whether this entry is ours *and* can actually run.
///
/// An unquoted path with a space in it installs cleanly, reads correctly in
/// the settings file, and never fires — so reporting it as connected tells
/// somebody the feature is on while nothing happens. Requiring the quoted
/// form means a stale install shows as disconnected and the button repairs
/// it.
fn is_ours_and_works(entry: &Value) -> bool {
    command_of(entry).is_some_and(|command| command.contains(TAG) && command.starts_with('\''))
}

fn command_of(entry: &Value) -> Option<&str> {
    entry
        .get("hooks")?
        .as_array()?
        .iter()
        .find_map(|hook| hook.get("command")?.as_str())
}

/// Write the forwarder and point the agent at it.
///
/// Merges rather than replaces: somebody else's hooks are none of this app's
/// business, and clobbering a file the user edits by hand would be a far
/// worse bug than the feature is worth. Settings that cannot be parsed are
/// left alone and reported, for the same reason.
pub fn install(app_dir: &Path) -> Result<String, String> {
    let path = settings_path().ok_or("No HOME, so no agent settings to write")?;

    std::fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
    let script = script_path(app_dir);
    std::fs::write(&script, script_body()).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut settings: Value = match std::fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => serde_json::from_str(&text)
            .map_err(|e| format!("{} is not valid JSON ({e}) — left alone", path.display()))?,
        _ => json!({}),
    };

    let hooks = settings
        .as_object_mut()
        .ok_or("Agent settings are not an object")?
        .entry("hooks")
        .or_insert_with(|| json!({}));

    let hooks = hooks.as_object_mut().ok_or("`hooks` is not an object")?;

    for (event, kind) in EVENTS {
        let list = hooks.entry(event).or_insert_with(|| json!([]));
        let list = list
            .as_array_mut()
            .ok_or_else(|| format!("`hooks.{event}` is not a list"))?;

        // Replace ours, keep everyone else's.
        list.retain(|entry| !is_ours(entry));
        list.push(json!({
            "matcher": "*",
            "hooks": [{
                "type": "command",
                "command": format!("{} {kind}", shell_quote(&script))
            }]
        }));
    }

    std::fs::write(&path, format!("{:#}\n", settings)).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Take them back out, leaving anything else in the file untouched.
pub fn uninstall() -> Result<(), String> {
    let Some(path) = settings_path() else {
        return Ok(());
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let mut settings: Value =
        serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON ({e})", path.display()))?;

    if let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) {
        for (event, _) in EVENTS {
            if let Some(list) = hooks.get_mut(event).and_then(Value::as_array_mut) {
                list.retain(|entry| !is_ours(entry));
            }
        }
        hooks.retain(|_, list| !list.as_array().is_some_and(|l| l.is_empty()));
    }

    std::fs::write(&path, format!("{:#}\n", settings)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_forwarder_can_never_fail_the_agent() {
        let body = script_body();
        assert!(body.contains("-m 1"), "a hung pet must not hang a tool call");
        assert!(body.ends_with("exit 0\n"), "always succeeds");
        assert!(body.contains(&HOOK_PORT.to_string()));
    }

    #[test]
    fn a_path_with_a_space_survives_the_agent_shell() {
        // The bug this pins shipped: macOS puts app data under
        // `Application Support`, so the unquoted command ran
        // `/Users/you/Library/Application` and the hooks never fired once.
        let quoted = shell_quote(Path::new("/Users/me/Library/Application Support/x/a.sh"));
        assert_eq!(quoted, "'/Users/me/Library/Application Support/x/a.sh'");
    }

    #[test]
    fn a_path_with_a_quote_in_it_cannot_break_out() {
        let quoted = shell_quote(Path::new("/tmp/it's/a.sh"));
        assert_eq!(quoted, r"'/tmp/it'\''s/a.sh'");
    }

    #[test]
    fn ours_is_recognised_by_the_command_path() {
        let mine = json!({ "hooks": [{ "type": "command", "command": "'/x/joygotchi/agent-hook.sh' prompt" }] });
        let theirs = json!({ "hooks": [{ "type": "command", "command": "/usr/bin/true" }] });

        assert!(is_ours(&mine));
        assert!(!is_ours(&theirs));
    }

    #[test]
    fn an_unquoted_install_counts_as_not_connected() {
        // It is ours, so replacing and removing must find it — but it cannot
        // run, so saying "connected" would be a lie with a button on it.
        let broken = json!({ "hooks": [{ "type": "command", "command": "/x/joygotchi/agent-hook.sh prompt" }] });

        assert!(is_ours(&broken), "still ours, so it can be repaired");
        assert!(!is_ours_and_works(&broken), "but not connected");
    }

    #[test]
    fn every_reacted_event_has_a_kind_the_pet_knows() {
        // `AgentEvent` in @joygotchi/pet is the other end of this list.
        for (_, kind) in EVENTS {
            assert!(matches!(kind, "tool-start" | "tool-end" | "prompt" | "idle"));
        }
    }
}
