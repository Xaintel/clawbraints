# Presentacion Tecnica del Brain

## Agentes actuales

El Brain corre con estos 9 agentes:

1. `TranslatorAgent`
2. `PMAgent`
3. `MobileAgent`
4. `OCRAgent`
5. `UXAgent`
6. `QAAgent`
7. `BuilderAgent`
8. `CoderAgent`
9. `DeployerAgent`

Fuente de configuracion:
- `config/templates/agents.yaml`
- `config/templates/policy.yaml`

## Persistencia y memoria (reinicios)

El estado duradero vive en `/data/clawbrain` (host bind mount), por lo que reiniciar contenedores no borra historial.

Componentes persistentes:
- DB de tareas/auditoria: `/data/clawbrain/db/clawbrain.sqlite3`
- Memoria por repo: `/data/clawbrain/memory/<repo>.md`
- Indice de memoria: tabla `repo_memory_index`
- Logs por tarea: `/data/clawbrain/logs`
- Artifacts de ejecucion: `/data/clawbrain/artifacts`

Como se actualiza la memoria:
- Al terminar cada tarea, `runner.worker` llama `update_memory(...)`.
- Se agrega una linea timestamped con el resumen final.
- Se recalcula hash y se actualiza `repo_memory_index`.

## Manejo de contexto

Contexto de entrada por tarea:
- `request_text`
- repo objetivo
- agente objetivo
- restricciones de policy

Para tareas `type=codex`:
- Se construye prompt con:
  - request del usuario
  - repo y agente
  - contenido de `AGENTS.md` del repo objetivo
  - reglas de ejecucion seguras

Memoria historica:
- Se persiste y puede consultarse via API:
  - `GET /repos/{repo}/memory`
  - `PUT /repos/{repo}/memory`
- Nota actual: no se inyecta automaticamente al prompt de cada task.

## Reparto de tareas entre agentes

### Cola y ejecucion

- API encola tasks en Redis (`RPUSH`).
- Workers consumen con `BLPOP` sobre `clawbrain:tasks`.
- Cada worker esta fijo por agente (`--agent`).
- Si toma una tarea de otro agente, la re-encola (requeue).

### Orquestacion PM

El planificador PM (`ide_client/pm_orchestrator.py`) crea flujo:
- `CoderAgent` siempre primero.
- `UXAgent` opcional (si se solicita o se infiere por keywords UX/UI).
- `BuilderAgent` opcional (por defecto se incluye para validacion final).
- `DeployerAgent` no se auto-encola; solo por decision explicita.

### Observabilidad de agentes

`agent-maintainer` publica:
- queue depth
- heartbeats activos por agente
- agentes faltantes
- snapshot en Redis + archivo de estado

## Seguridad operativa

- Workers no root (validacion de identidad Linux por agente).
- Token obligatorio (`X-Clawbrain-Token`).
- Policy estricta por agente/repos/comandos/rutas.
- Auditoria por evento (`audit_events`).
- `DeployerAgent` con sudo limitado a scripts permitidos.

## Resultado practico para la pega

- Brain modular, portable y auditable.
- Reinicio seguro con memoria persistente.
- Integrable por API, CLI y chat MCP (VS Code/Cursor).
- Flujo multiagente con control de permisos y trazabilidad completa.
