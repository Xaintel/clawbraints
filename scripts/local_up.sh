#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export CLAWBRAIN_LOCAL_ROOT="${CLAWBRAIN_LOCAL_ROOT:-$ROOT_DIR/.local}"
export CLAWBRAIN_LOCAL_DATA_ROOT="${CLAWBRAIN_LOCAL_DATA_ROOT:-$ROOT_DIR/.local/data}"
export CLAWBRAIN_LOCAL_REPO_ROOT="${CLAWBRAIN_LOCAL_REPO_ROOT:-$ROOT_DIR}"
export CLAWBRAIN_LOCAL_BRAIN_REPO_NAME="${CLAWBRAIN_LOCAL_BRAIN_REPO_NAME:-$(basename "$CLAWBRAIN_LOCAL_REPO_ROOT")}"
if [[ -n "${CLAWBRAIN_LOCAL_PROJECTS_ROOT:-}" ]]; then
  export CLAWBRAIN_LOCAL_PROJECTS_ROOT
elif [[ -n "${CLAWBRAIN_LOCAL_DEMO_ROOT:-}" ]]; then
  export CLAWBRAIN_LOCAL_PROJECTS_ROOT="$(dirname "$CLAWBRAIN_LOCAL_DEMO_ROOT")"
else
  export CLAWBRAIN_LOCAL_PROJECTS_ROOT="$ROOT_DIR/.local/projects"
fi
export CLAWBRAIN_PROJECTS_ROOT="${CLAWBRAIN_PROJECTS_ROOT:-$CLAWBRAIN_LOCAL_PROJECTS_ROOT}"
export CLAWBRAIN_LOCAL_DEMO_ROOT="${CLAWBRAIN_LOCAL_DEMO_ROOT:-$CLAWBRAIN_LOCAL_PROJECTS_ROOT/demo}"
export CLAWBRAIN_LOCAL_CODEX_AUTH_SOURCE_DIR="${CLAWBRAIN_LOCAL_CODEX_AUTH_SOURCE_DIR:-$HOME/.codex}"
export CLAWBRAIN_LOCAL_CODEX_AUTH_DIR="${CLAWBRAIN_LOCAL_CODEX_AUTH_DIR:-$ROOT_DIR/.local/codex-auth}"
export CLAWBRAIN_COMMAND_TIMEOUT_SEC="${CLAWBRAIN_COMMAND_TIMEOUT_SEC:-600}"

PROJECT_NAME="${CLAWBRAIN_LOCAL_PROJECT_NAME:-clawbrain-local}"

mkdir -p "$CLAWBRAIN_LOCAL_CODEX_AUTH_DIR"
if [[ -d "$CLAWBRAIN_LOCAL_CODEX_AUTH_SOURCE_DIR" ]]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$CLAWBRAIN_LOCAL_CODEX_AUTH_SOURCE_DIR"/ "$CLAWBRAIN_LOCAL_CODEX_AUTH_DIR"/
  else
    shopt -s dotglob nullglob
    rm -rf "$CLAWBRAIN_LOCAL_CODEX_AUTH_DIR"/*
    shopt -u dotglob nullglob
    cp -a "$CLAWBRAIN_LOCAL_CODEX_AUTH_SOURCE_DIR"/. "$CLAWBRAIN_LOCAL_CODEX_AUTH_DIR"/
  fi
  chmod -R a+rwX "$CLAWBRAIN_LOCAL_CODEX_AUTH_DIR"
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  if [[ -f "$CLAWBRAIN_LOCAL_CODEX_AUTH_DIR/auth.json" ]]; then
    echo "[local-up] using codex login session from $CLAWBRAIN_LOCAL_CODEX_AUTH_SOURCE_DIR"
  else
    echo "[local-up][warn] no OPENAI_API_KEY and no codex auth at $CLAWBRAIN_LOCAL_CODEX_AUTH_SOURCE_DIR"
    echo "[local-up][warn] run 'codex login --device-auth' or export OPENAI_API_KEY"
  fi
fi

"$ROOT_DIR/scripts/bootstrap_local.sh"

if [[ -n "${CLAWBRAIN_LOCAL_ALLOWED_REPOS:-}" ]]; then
  effective_repos="$CLAWBRAIN_LOCAL_ALLOWED_REPOS"
else
  effective_repos="demo,$CLAWBRAIN_LOCAL_BRAIN_REPO_NAME"
  if [[ -d "$CLAWBRAIN_PROJECTS_ROOT" ]]; then
    while IFS= read -r repo_name; do
      repo_path="$CLAWBRAIN_PROJECTS_ROOT/$repo_name"
      if [[ "$repo_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [[ -d "$repo_path/.git" || -f "$repo_path/.git" ]]; then
        effective_repos="$effective_repos,$repo_name"
      fi
    done < <(find "$CLAWBRAIN_PROJECTS_ROOT" -mindepth 1 -maxdepth 1 -type d -printf "%f\n" | sort -u)
  fi
fi

policy_report="$(mktemp)"
cleanup() {
  rm -f "$policy_report"
}
trap cleanup EXIT

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "[local-up] installing npm dependencies"
  (cd "$ROOT_DIR" && npm install >/dev/null)
fi
if [[ ! -f "$ROOT_DIR/dist/scripts/configure_local_policy.js" ]]; then
  echo "[local-up] building TypeScript runtime"
  (cd "$ROOT_DIR" && npm run build >/dev/null)
fi

node "$ROOT_DIR/dist/scripts/configure_local_policy.js" \
  --policy-file "$CLAWBRAIN_LOCAL_DATA_ROOT/config/policy.yaml" \
  --repos "$effective_repos" \
  --projects-root /srv/projects >"$policy_report"
echo "[local-up] policy configured: $(cat "$policy_report")"

docker compose \
  -p "$PROJECT_NAME" \
  -f "$ROOT_DIR/docker-compose.yml" \
  -f "$ROOT_DIR/docker-compose.local.yml" \
  up -d --build "$@"

echo "[local-up] ClawBrain local running with project: $PROJECT_NAME"
echo "[local-up] API: ${CLAWBRAIN_LOCAL_API_BIND:-127.0.0.1:18088}"
echo "[local-up] verify: $ROOT_DIR/scripts/verify_brain_local.sh"
