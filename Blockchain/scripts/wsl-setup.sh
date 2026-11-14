#!/usr/bin/env bash
# One-time toolchain setup for building and running Yuki on Linux / WSL.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v cc >/dev/null || ! command -v pkg-config >/dev/null; then
  SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  $SUDO apt-get update -y && $SUDO apt-get install -y build-essential pkg-config libssl-dev curl git rsync clang libudev-dev
fi
if ! command -v rustup >/dev/null && [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add wasm32-unknown-unknown
if ! command -v cargo-near >/dev/null; then
  curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
fi
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install 24 >/dev/null
nvm alias default 24 >/dev/null
corepack enable || npm i -g pnpm@10
echo "rustc: $(rustc --version)"; echo "cargo-near: $(cargo near --version 2>&1 | head -1)"; echo "node: $(node -v)"; echo "pnpm: $(pnpm -v 2>&1 | tail -1)"
