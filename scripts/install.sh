#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/desktop/plugin.js"
DST_DIR="${HERMES_HOME:-$HOME/.hermes}/desktop-plugins/git-tasks"
mkdir -p "$DST_DIR"
ln -sfn "$SRC" "$DST_DIR/plugin.js"
echo "installed: $DST_DIR/plugin.js -> $SRC"
echo "now run 'Reload desktop plugins' (Ctrl+K) in Hermes Desktop"
