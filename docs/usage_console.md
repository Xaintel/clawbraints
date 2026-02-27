# Uso por Consola

## Configurar cliente IDE local

Puedes usar variables de entorno:

```bash
export CLAWBRAIN_IDE_SERVER_URL="http://127.0.0.1:8088"
export CLAWBRAIN_IDE_TOKEN="$(cat /data/clawbrain/secrets/api_token)"
```

Modo local (`scripts/local_up.sh`):

```bash
export CLAWBRAIN_IDE_SERVER_URL="http://127.0.0.1:18088"
export CLAWBRAIN_IDE_TOKEN="$(cat /srv/clawbrain/clawbraints/.local/data/secrets/api_token)"
```

O guardar config local:

```bash
scripts/clawbrain-ide config-set \
  --server-url http://127.0.0.1:8088 \
  --token "$(cat /data/clawbrain/secrets/api_token)"
```

## Comandos base

```bash
scripts/clawbrain-ide config-show
scripts/clawbrain-ide agents
```

## Crear tarea command

```bash
scripts/clawbrain-ide create-task \
  --type command \
  --repo demo \
  --agent BuilderAgent \
  --command 'node -e "console.log(123)"' \
  --request-text 'smoke check'
```

## Esperar y revisar

```bash
scripts/clawbrain-ide wait-task <task_id>
scripts/clawbrain-ide get-task <task_id>
scripts/clawbrain-ide get-logs <task_id>
```

## Tarea codex y diff

```bash
scripts/clawbrain-ide create-task \
  --type codex \
  --repo demo \
  --agent CoderAgent \
  --request-text 'crear NOTES.md con hello'

scripts/clawbrain-ide wait-task <task_id>
scripts/clawbrain-ide get-diff <task_id> --output /tmp/diff.patch
```

## Aplicar patch local (con confirmacion)

```bash
scripts/clawbrain-ide apply-patch-local \
  --patch /tmp/diff.patch \
  --repo /ruta/al/repo
```
