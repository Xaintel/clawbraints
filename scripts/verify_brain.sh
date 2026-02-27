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
python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path('/tmp/clawbrain_brain_agents.json').read_text(encoding='utf-8'))
agents = payload.get('agents')
if not isinstance(agents, list) or not agents:
    raise SystemExit('[FAIL] invalid agents payload')
print(f"[verify] agents_count={len(agents)}")
PY

echo "[verify] create command task"
cat > /tmp/clawbrain_brain_task.json <<'JSON'
{
  "type": "command",
  "repo": "demo",
  "agent": "BuilderAgent",
  "command": "python3 -c \"print(123)\"",
  "request_text": "brain verify"
}
JSON

curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Clawbrain-Token: $TOKEN" \
  --data @/tmp/clawbrain_brain_task.json \
  "$BASE_URL/api/ide/tasks" >/tmp/clawbrain_brain_task_create.json

TASK_ID="$(python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path('/tmp/clawbrain_brain_task_create.json').read_text(encoding='utf-8'))
value = payload.get('task_id')
if not value:
    raise SystemExit('missing task_id')
print(value)
PY
)"

echo "[verify] task_id=$TASK_ID"

for _ in $(seq 1 60); do
  curl -fsS -H "X-Clawbrain-Token: $TOKEN" "$BASE_URL/api/ide/tasks/$TASK_ID" >/tmp/clawbrain_brain_task_status.json
  STATUS="$(python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path('/tmp/clawbrain_brain_task_status.json').read_text(encoding='utf-8'))
print(payload.get('status',''))
PY
)"
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
