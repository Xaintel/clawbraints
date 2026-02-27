# Brain Local Dev

Modo local para correr el Brain sin tocar `/data/clawbrain` ni `/srv/projects` del host.

## Que crea

- Datos persistentes: `./.local/data`
- Repo demo: `./.local/projects/demo`
- Token local: `./.local/data/secrets/api_token`
- API local: `http://127.0.0.1:18088`

## Levantar

```bash
cd /srv/clawbrain/clawbrain-brain
./scripts/local_up.sh
```

## Multi-repo (sin limitarse a `demo`)

Por defecto se monta `./.local/projects` en `/srv/projects`. Si quieres usar tus repos reales (por ejemplo `~/Proyecto`), define:

```bash
export CLAWBRAIN_LOCAL_PROJECTS_ROOT="$HOME/Proyecto"
./scripts/local_up.sh
```

Opcionalmente puedes limitar repos permitidos por policy:

```bash
export CLAWBRAIN_LOCAL_ALLOWED_REPOS="demo,clawbrain,claw-jira-app"
./scripts/local_up.sh
```

`local_up.sh` parchea automaticamente `.local/data/config/policy.yaml` para alinear:
- `repos_allowed`
- `paths.projects_root`
- `commands_whitelist` de `codex exec ... -C /srv/projects/<repo> -`
- Deteccion automatica de repos: solo carpetas git de primer nivel (con `.git`).

## Verificar

```bash
./scripts/verify_brain_local.sh
```

## Bajar

```bash
./scripts/local_down.sh
```

## Notas de codex tasks

- Esta variante usa `runner/Dockerfile.local` e instala `@openai/codex` dentro del runner.
- Para auth puedes usar cualquiera de estas dos opciones:
  - Login de sesion (recomendado si ya usas ChatGPT login): `codex login --device-auth` en el host.
  - API key: exportar `OPENAI_API_KEY`.
- `local_up.sh` sincroniza `~/.codex` a `./.local/codex-auth` y monta esa copia en lectura/escritura dentro de runners.
- Si no hay login ni key, los tasks `type=codex` pueden terminar en `failed/blocked`.
- Timeout por comando de agente: `CLAWBRAIN_COMMAND_TIMEOUT_SEC` (default `600`).

## Rama mobile y uso remoto

Para flujo completo en rama `mobile` (WSL + cliente remoto de pega + MCP), ver:

- `docs/mobile_setup.md`

## MCP local

Para `scripts/clawbrain-mcp-server-auto`, usa:

```bash
export CLAWBRAIN_MCP_ENV_FILE=/srv/clawbrain/clawbrain-brain/.env.mcp.local
```

Contenido sugerido de `.env.mcp.local`:

```bash
CLAWBRAIN_IDE_SERVER_URL=http://127.0.0.1:18088
CLAWBRAIN_IDE_TOKEN_FILE=/srv/clawbrain/clawbrain-brain/.local/data/secrets/api_token
```
