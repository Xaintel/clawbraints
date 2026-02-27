#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LOCAL_ROOT="${CLAWBRAIN_LOCAL_ROOT:-$ROOT_DIR/.local}"
DATA_ROOT="${CLAWBRAIN_LOCAL_DATA_ROOT:-$LOCAL_ROOT/data}"
PROJECTS_ROOT="${CLAWBRAIN_LOCAL_PROJECTS_ROOT:-$LOCAL_ROOT/projects}"

CONFIG_DIR="$DATA_ROOT/config"
DB_DIR="$DATA_ROOT/db"
LOGS_DIR="$DATA_ROOT/logs"
MEMORY_DIR="$DATA_ROOT/memory"
ARTIFACTS_DIR="$DATA_ROOT/artifacts"
SECRETS_DIR="$DATA_ROOT/secrets"
TOKEN_FILE="$SECRETS_DIR/api_token"
DB_PATH="$DB_DIR/clawbrain.sqlite3"
DEMO_REPO="$PROJECTS_ROOT/demo"

echo "[local-bootstrap] preparing directories under $LOCAL_ROOT"
mkdir -p \
  "$CONFIG_DIR" \
  "$DB_DIR" \
  "$LOGS_DIR" \
  "$MEMORY_DIR" \
  "$ARTIFACTS_DIR" \
  "$SECRETS_DIR" \
  "$DEMO_REPO"

chmod 700 "$SECRETS_DIR"
chmod 777 "$DB_DIR" "$LOGS_DIR" "$MEMORY_DIR" "$ARTIFACTS_DIR"

if [[ ! -f "$TOKEN_FILE" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 >"$TOKEN_FILE"
  else
    node -e 'const c=require("node:crypto");process.stdout.write(c.randomBytes(32).toString("hex") + "\\n");' >"$TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
  echo "[local-bootstrap] created token: $TOKEN_FILE"
else
  chmod 600 "$TOKEN_FILE"
  echo "[local-bootstrap] token already exists: $TOKEN_FILE"
fi

echo "[local-bootstrap] installing config templates"
CLAWBRAIN_CONFIG_DIR="$CONFIG_DIR" "$ROOT_DIR/scripts/install_config_templates.sh"

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "[local-bootstrap] installing npm dependencies"
  (cd "$ROOT_DIR" && npm install >/dev/null)
fi
if [[ ! -f "$ROOT_DIR/dist/scripts/migrate.js" ]]; then
  echo "[local-bootstrap] building TypeScript runtime"
  (cd "$ROOT_DIR" && npm run build >/dev/null)
fi

echo "[local-bootstrap] applying migrations"
node "$ROOT_DIR/dist/scripts/migrate.js" --db-path "$DB_PATH"
chmod 666 "$DB_PATH"

if [[ ! -f "$DEMO_REPO/README.md" ]]; then
  cat >"$DEMO_REPO/README.md" <<'EOF'
# demo

Local demo repository for ClawBrain smoke checks.
EOF
fi

echo "[local-bootstrap] ready"
echo "  data root:    $DATA_ROOT"
echo "  projects root: $PROJECTS_ROOT"
echo "  api token:    $TOKEN_FILE"
