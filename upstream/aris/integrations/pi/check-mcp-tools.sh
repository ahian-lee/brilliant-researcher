#!/usr/bin/env bash
# Check actual Pi skill discovery and reviewer tools without model calls.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
WORKDIR="$(cd "${1:-$PWD}" && pwd)"
[ ! -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] || . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
bash "$DIR/pi-aris.sh" auto-review-loop --workdir "$WORKDIR" --prepare-only
PI_OFFLINE=1 timeout 45 node "$DIR/check-tools.mjs" "$(command -v pi)" "$WORKDIR" "$ROOT"
