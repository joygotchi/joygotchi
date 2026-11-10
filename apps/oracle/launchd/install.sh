#!/usr/bin/env bash
#
# Install the oracle as a login agent, or update it in place.
#
#   ./install.sh <oracle-account> [network] [site]
#
# Reads nothing secret. The key stays in ~/.near-credentials, where
# `near account add-key … save-to-legacy-keychain` put it, and the process
# reads it there — so nothing here, and nothing in launchd's plist, ever
# holds the secret.
set -euo pipefail

ACCOUNT="${1:?usage: ./install.sh <oracle-account> [network]}"
NETWORK="${2:-testnet}"
# The web service the oracle asks for a meal's grade. It holds the model key;
# this machine holds the NEAR key, and only this machine signs.
SITE="${3:-https://joygotchi.vercel.app}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ORACLE_DIR="$(dirname "$HERE")"
NODE="$(command -v node)"
LOG_DIR="$HOME/Library/Logs/joygotchi"
LABEL="dev.joygotchi.oracle"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Fail here rather than in a log file nobody reads: a plist that points at a
# missing key produces a process that restarts every minute and feeds nothing.
KEY_FILE="$HOME/.near-credentials/$NETWORK/$ACCOUNT.json"
if [ ! -f "$KEY_FILE" ]; then
  echo "No key at $KEY_FILE." >&2
  echo "Grant one first — see the 'Granting the key' section of the README." >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

sed -e "s|__NODE__|$NODE|g" \
    -e "s|__ORACLE_DIR__|$ORACLE_DIR|g" \
    -e "s|__ORACLE_ACCOUNT__|$ACCOUNT|g" \
    -e "s|__NETWORK__|$NETWORK|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__SITE__|$SITE|g" \
    "$HERE/$LABEL.plist.template" > "$PLIST"

# Unload first so this is an update rather than a second copy. `|| true`
# because the first install has nothing to unload.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

echo "Installed $LABEL for $ACCOUNT on $NETWORK."
echo "  grades:  POST http://127.0.0.1:8787/grade, graded against $SITE"
echo "  logs:    $LOG_DIR/oracle.log"
echo "  stop:    launchctl bootout gui/$UID/$LABEL"
echo "  restart: launchctl kickstart -k gui/$UID/$LABEL"
