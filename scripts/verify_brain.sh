#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${CLAWBRAIN_BASE_URL:-http://127.0.0.1:8088}"
TOKEN_FILE="${CLAWBRAIN_TOKEN_FILE:-/data/clawbrain/secrets/api_token}"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "[FAIL] token file not found: $TOKEN_FILE"
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"

echo "[verify] health"
curl -fsS "$BASE_URL/health" >/tmp/clawbrain_brain_health.json
cat /tmp/clawbrain_brain_health.json

echo "[verify] ide agents"
curl -fsS -H "X-Clawbrain-Token: $TOKEN" "$BASE_URL/api/ide/agents" >/tmp/clawbrain_brain_agents.json
node -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync("/tmp/clawbrain_brain_agents.json","utf8"));if(!Array.isArray(p.agents)||p.agents.length===0){console.error("[FAIL] invalid agents payload");process.exit(1);}console.log(`[verify] agents_count=${p.agents.length}`);'

echo "[verify] create command task"
cat > /tmp/clawbrain_brain_task.json <<'JSON'
{
  "type": "command",
  "repo": "demo",
  "agent": "BuilderAgent",
  "command": "node -e \"console.log(123)\"",
  "request_text": "brain verify"
}
JSON

curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Clawbrain-Token: $TOKEN" \
  --data @/tmp/clawbrain_brain_task.json \
  "$BASE_URL/api/ide/tasks" >/tmp/clawbrain_brain_task_create.json

TASK_ID="$(node -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync("/tmp/clawbrain_brain_task_create.json","utf8"));if(!p.task_id){console.error("missing task_id");process.exit(1);}process.stdout.write(String(p.task_id));')"

echo "[verify] task_id=$TASK_ID"

for _ in $(seq 1 60); do
  curl -fsS -H "X-Clawbrain-Token: $TOKEN" "$BASE_URL/api/ide/tasks/$TASK_ID" >/tmp/clawbrain_brain_task_status.json
  STATUS="$(node -e 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync("/tmp/clawbrain_brain_task_status.json","utf8"));process.stdout.write(String(p.status||""));')"
  if [[ "$STATUS" == "succeeded" ]]; then
    echo "[verify] task succeeded"
    echo "BRAIN VERIFY: PASS"
    exit 0
  fi
  if [[ "$STATUS" == "failed" || "$STATUS" == "blocked" || "$STATUS" == "canceled" ]]; then
    echo "[FAIL] task status=$STATUS"
    exit 1
  fi
  sleep 1
done

echo "[FAIL] timeout waiting task"
exit 1
