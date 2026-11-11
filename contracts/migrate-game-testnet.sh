#!/usr/bin/env bash
# Upgrade a live game deployment in place, keeping every pet.
#
#   ./migrate-game-testnet.sh <suffix>
#
# This deploy adds `species`, `species_price` and `revenue_banked` to the
# contract struct, which is a Borsh layout change: the new code cannot read
# what the old code wrote. A `without-init-call` deploy would take the
# contract down with `Cannot deserialize the contract state`, and this
# repository has already lost two deployments to exactly that
# (docs/GAME_CONTRACT_V2.md §9).
#
# Deploy and migrate go in one transaction, so there is no window in which
# the new code is live over state it cannot read.
#
# `migrate` is checked against the real deployed bytes before it is ever
# run: `contracts/game/tests/migration.rs` deserialises the live `STATE` key
# with the same layout. A unit test cannot do this — it builds the old
# struct with the same compiler that reads it back, so it agrees with itself
# and proves nothing about bytes a different binary wrote.
set -euo pipefail

SUF="${1:?usage: ./migrate-game-testnet.sh <suffix>}"
cd "$(dirname "$0")"

GAME="jg-game-$SUF.testnet"
WASM=target/near/game/game.wasm

test -f "$WASM" || {
  echo "No $WASM — run: cd game && cargo near build non-reproducible-wasm --no-abi" >&2
  exit 1
}

echo "── the state this migration has been tested against"
cargo test --manifest-path game/Cargo.toml --test migration -- --nocapture

echo
echo "── $GAME"
near contract deploy "$GAME" use-file "$WASM" \
  with-init-call migrate json-args '{}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

echo
echo "── state after the migration (every pet should still read)"
near contract call-function as-read-only "$GAME" get_config json-args '{}' \
  network-config testnet now
near contract call-function as-read-only "$GAME" list_species json-args '{}' \
  network-config testnet now
near contract call-function as-read-only "$GAME" get_pets json-args '{}' \
  network-config testnet now

echo
echo "── pets minted before the registry still carry a relative media path."
echo "   Rewrite them (owner only, resumable, safe to repeat):"
echo
echo "   near contract call-function as-transaction $GAME refresh_metadata \\"
echo "     json-args '{\"from_pet_id\":1,\"limit\":50}' prepaid-gas '100.0 Tgas' \\"
echo "     attached-deposit '0 NEAR' sign-as $GAME network-config testnet sign-with-keychain send"
