# Arquitectura Brain

## Flujo de una tarea

1. Cliente (API/CLI/MCP) envia task.
2. API valida token, repo permitido, agente permitido y comando permitido por policy.
3. API crea registro en SQLite (`tasks`) y encola job en Redis.
4. Worker del agente toma job y ejecuta:
   - `type=command`: comando directo validado.
   - `type=codex`: flujo `codex exec` controlado.
5. Worker escribe:
   - estado final de tarea
   - logs
   - eventos de auditoria
   - artifacts (`summary.md`, `diff.patch`, `prompt.txt`, etc.)
6. IDE/CLI/MCP consultan estado/logs/diff/artifacts para review y aplicacion local.

## Componentes

- `api/`: endpoints HTTP de tasks, IDE y estado.
- `runner/`: workers, maintainer, cola, DB.
- `shared/`: validacion de policy y restricciones.
- `ide_client/`: cliente HTTP + MCP server + PM orchestration.

## Persistencia

- DB: `/data/clawbrain/db/clawbrain.sqlite3`
- Logs: `/data/clawbrain/logs`
- Memoria por repo: `/data/clawbrain/memory`
- Artifacts: `/data/clawbrain/artifacts`
- Config/policy: `/data/clawbrain/config`

## Modelo de seguridad

- Sin shell libre; whitelist exacta por agente.
- Workers bajo usuarios no-root.
- Secrets en `/data/clawbrain/secrets` con permisos estrictos.
- Auditoria de eventos por task.

