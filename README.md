# Clawbraints (TypeScript Migration)

Repositorio nuevo, enfocado en el Brain de orquestacion tecnica y su migracion progresiva a TypeScript.

## Que es este Brain

Si, este proyecto funciona como un Brain operativo para tareas de desarrollo.

Hace 4 cosas principales:
1. Recibe tareas por API (`/api/tasks`, `/api/ide/tasks`).
2. Valida politica de seguridad (`policy.yaml`) y whitelist de comandos.
3. Encola y distribuye tareas a agentes workers (Coder, Builder, UX, QA, etc.).
4. Guarda estado, logs, auditoria y artifacts para consumo de IDE/CLI/MCP.

## Lo que incluye

- API Fastify + runtime de agentes en TypeScript (`src/`)
- Scripts operativos TypeScript (`src/scripts/` + wrappers `scripts/*`)
- Integracion IDE local (CLI + MCP) TypeScript (`src/ide_client/`)
- Migraciones SQLite (`migrations/`)
- Compose Brain-only (`docker-compose.yml`)
- Skills locales (`skills/`)
- Documentacion de implementacion/uso (`docs/`)

## Lo que NO incluye

- Emulador
- Launcher de juegos
- Flujo ROM/Jelly multimedia
- UI de portal gamer

## Estado de migracion a TypeScript

- Migracion completada: runtime del Brain 100% TypeScript (sin archivos Python en repo).
- Servidor y agentes TS con endpoints clave:
  - `/health`
  - `/tasks`, `/tasks/{id}`, `/tasks/{id}/logs`
  - `/repos/{repo}/memory` (GET/PUT)
  - `/ide/*` y `/api/ide/*` (agentes, tasks, artifacts, diff)
- Mantiene validacion de policy, auth por token, SQLite y cola Redis.

## Quickstart TypeScript

```bash
cd /srv/clawbrain/clawbraints
npm install
npm run build
npm run dev
```

## Arquitectura rapida

- `clawbrain-api`: API y validacion.
- `redis`: cola de tareas.
- `runner-*`: ejecutores por agente.
- `agent-maintainer`: estado de salud de agentes.
- `sqlite`: metadata de tareas y auditoria.

Detalles: `docs/architecture.md`.

## Inicio rapido

### 1) Preparar paths persistentes

```bash
sudo mkdir -p /srv/projects
sudo mkdir -p /data/clawbrain/{config,db,logs,memory,artifacts,secrets}
sudo chmod 700 /data/clawbrain/secrets
sudo chmod 777 /data/clawbrain/{db,logs,memory,artifacts}
```

### 2) Instalar config base

```bash
cd /srv/clawbrain/clawbraints
./scripts/install_config_templates.sh
```

### 3) Crear token API

```bash
sudo sh -c 'openssl rand -hex 32 > /data/clawbrain/secrets/api_token'
sudo chmod 600 /data/clawbrain/secrets/api_token
```

### 4) Ejecutar migraciones

```bash
./scripts/migrate --db-path /data/clawbrain/db/clawbrain.sqlite3
```

### 5) Levantar servicios

```bash
docker compose up -d --build
```

### 6) Validar

```bash
curl -fsS http://127.0.0.1:8088/health
./scripts/verify_brain.sh
```

## Modo local rapido (sin /data global)

Para usar el Brain completamente local en tu maquina (datos en `./.local`):

```bash
cd /srv/clawbrain/clawbraints
# Si ya usas login de Codex/ChatGPT en este host, se reutiliza automaticamente (~/.codex).
# Alternativa: export OPENAI_API_KEY="..."
./scripts/local_up.sh
./scripts/verify_brain_local.sh
```

Para trabajar con repos reales fuera de `demo`:

```bash
export CLAWBRAIN_LOCAL_PROJECTS_ROOT="$HOME/Proyecto"
./scripts/local_up.sh
```

`local_up.sh` actualiza policy local automaticamente para permitir esos repos.

Apagado:

```bash
./scripts/local_down.sh
```

Detalle completo: `docs/local_dev.md`.
Guia completa para levantar y usar la rama `mobile`: `docs/mobile_setup.md`.

## Uso por consola e IDE

- CLI local: `docs/usage_console.md`
- Chat Codex en VS Code/Cursor por MCP: `docs/usage_codex_chat_mcp.md`
  - Incluye ejemplos de prompts, archivo a editar (`.env.mcp`) y troubleshooting.

## Skills

- Explicacion de skills instaladas y como se instalaron: `docs/skills.md`

## Seguridad

- Token obligatorio (`X-Clawbrain-Token`).
- Secrets fuera de git.
- Workers no-root.
- Comandos permitidos solo por whitelist en `policy.yaml`.

## Operacion

- Guia de implementacion y hardening: `docs/implementation.md`

## Presentacion Tecnica

- Resumen tecnico para presentacion (agentes, memoria, contexto y reparto de tareas):
  - `docs/presentation_technical.md`
