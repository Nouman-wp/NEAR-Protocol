#!/usr/bin/env bash
# Build the three contracts to wasm with cargo-near and copy them to Blockchain/contracts/res/.
# Needs Rust with the wasm32-unknown-unknown target and cargo-near (see Blockchain/scripts/wsl-setup.sh).
set -euo pipefail
cd "$(dirname "$0")/../contracts"
mkdir -p res
for crate in quorum intents-lite test-usdc; do
  echo "building $crate"
  (cd "$crate" && cargo near build non-reproducible-wasm --no-abi >/dev/null 2>"../res/$crate.build.log") || {
    tail -30 "res/$crate.build.log"
    exit 1
  }
  name="${crate//-/_}"
  target="${CARGO_TARGET_DIR:-target}"
  cp "$target/near/$name/$name.wasm" "res/$name.wasm"
  rm -f "res/$crate.build.log"
done
ls -la res/*.wasm
