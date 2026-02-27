# Brain FAQ

## Verdaderamente funciona como un Brain?

Si.

Porque cumple el ciclo completo de orquestacion:
- recibe tareas,
- valida reglas,
- distribuye a agentes,
- ejecuta,
- guarda memoria/logs/auditoria,
- devuelve artifacts para aplicar cambios.

## Como decide que puede ejecutar?

Por politica (`/data/clawbrain/config/policy.yaml`):
- repos permitidos (`repos_allowed`),
- agentes permitidos,
- comandos exactos permitidos (`commands_whitelist`),
- rutas de escritura permitidas.

## Donde vive el estado?

- DB SQLite: `/data/clawbrain/db/clawbrain.sqlite3`
- Logs: `/data/clawbrain/logs`
- Memoria por repo: `/data/clawbrain/memory`
- Artifacts: `/data/clawbrain/artifacts`

## Como lo uso desde chat en VS Code/Cursor?

Con MCP, no con extension custom de este repo.
Ver `docs/usage_codex_chat_mcp.md`.

## Que pasa si no hay `codex` en runner?

Las tareas `type=codex` quedan `blocked` con instrucciones/manual run (`run.sh`).

