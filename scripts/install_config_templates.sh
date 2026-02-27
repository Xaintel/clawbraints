#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/../config/templates"
DST_DIR="${CLAWBRAIN_CONFIG_DIR:-/data/clawbrain/config}"
FILES=("policy.yaml" "agents.yaml")
FILES+=("apps.yaml")

echo "[INFO] Preparing destination directory: $DST_DIR"
mkdir -p "$DST_DIR"

for name in "${FILES[@]}"; do
  src="$SRC_DIR/$name"
  dst="$DST_DIR/$name"

  if [[ ! -f "$src" ]]; then
    echo "[ERROR] Missing template: $src" >&2
    exit 1
  fi

  if [[ -e "$dst" ]]; then
    echo "[SKIP] Exists (not overwritten): $dst"
  else
    # Runner workers run as non-root users and must read active config YAML files.
    install -m 0644 "$src" "$dst"
    echo "[OK] Installed: $dst"
  fi
done
