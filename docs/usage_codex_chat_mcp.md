# Uso en Chat Codex (VS Code/Cursor) por MCP

## Estado real

Si, esta implementado y usable por MCP stdio.

Componentes:
- Server MCP simple: `scripts/clawbrain-mcp-server`
- Server MCP auto-configurable: `scripts/clawbrain-mcp-server-auto`
- Implementacion MCP: `src/ide_client/mcp_server.ts`
- Tools expuestas:
  - `clawbrain.create_task`
  - `clawbrain.get_task`
  - `clawbrain.get_logs`
  - `clawbrain.get_diff`
  - `clawbrain.list_agents`
  - `clawbrain.apply_patch_local`
  - tools PM (`clawbrain.pm_*`)

## Configuracion recomendada (archivo + comando)

### 1) Archivo a editar cuando no toma el Brain

Archivo recomendado:

- `/srv/clawbrain/clawbraints/.env.mcp`

Crearlo desde template:

```bash
cd /srv/clawbrain/clawbraints
cp .env.mcp.example .env.mcp
```

Editar `.env.mcp` y ajustar:

```bash
CLAWBRAIN_IDE_SERVER_URL=http://127.0.0.1:8088
CLAWBRAIN_IDE_TOKEN_FILE=/data/clawbrain/secrets/api_token
```

Modo local (`scripts/local_up.sh`):

```bash
CLAWBRAIN_IDE_SERVER_URL=http://127.0.0.1:18088
CLAWBRAIN_IDE_TOKEN_FILE=/srv/clawbrain/clawbraints/.local/data/secrets/api_token
```

### 2) Comando MCP a usar en tu IDE

Usa este comando en tu configuracion MCP del cliente:

```text
/srv/clawbrain/clawbraints/scripts/clawbrain-mcp-server-auto
```

Con esto no necesitas hardcodear token en el JSON del IDE.

## Configuracion MCP en IDE (snippet)

Snippet generico para clientes compatibles:

```json
{
  "mcpServers": {
    "clawbrain": {
      "command": "/srv/clawbrain/clawbraints/scripts/clawbrain-mcp-server-auto"
    }
  }
}
```

Si prefieres modo explicito (sin `.env.mcp`):

```json
{
  "mcpServers": {
    "clawbrain": {
      "command": "/srv/clawbrain/clawbraints/scripts/clawbrain-mcp-server",
      "env": {
        "CLAWBRAIN_IDE_SERVER_URL": "http://127.0.0.1:8088",
        "CLAWBRAIN_IDE_TOKEN": "<token>"
      }
    }
  }
}
```

## Ejemplos de prompts en chat Codex

### Ejemplo 1: confirmar conexion al Brain

Prompt:

```text
Usa clawbrain.list_agents y dime los agentes disponibles.
```

### Ejemplo 2: crear tarea tecnica simple

Prompt:

```text
Crea una tarea en ClawBrain:
- type: command
- repo: demo
- agent: BuilderAgent
- command: node -e "console.log(123)"
- request_text: smoke desde chat
Luego consulta el estado hasta que termine.
```

### Ejemplo 3: flujo codex con diff

Prompt:

```text
Crea una tarea codex para CoderAgent en repo demo que cree NOTES.md.
Cuando termine, trae logs y diff.
No apliques el patch automaticamente.
```

### Ejemplo 4: orquestacion PM

Prompt:

```text
Usa clawbrain.pm_plan con:
- repo: demo
- goal: corregir bug login y mejorar UX mobile
- needs_ux: yes
- needs_builder: yes
Muestra el plan y luego despacha con clawbrain.pm_dispatch.
```

## Si el chat no toma el Brain (checklist)

1. Verifica Brain API:

```bash
curl -fsS http://127.0.0.1:8088/health
```

2. Verifica token/API IDE:

```bash
TOKEN="$(cat /data/clawbrain/secrets/api_token)"
curl -fsS -H "X-Clawbrain-Token: $TOKEN" http://127.0.0.1:8088/api/ide/agents
```

3. Verifica archivo editado:

- `/srv/clawbrain/clawbraints/.env.mcp`

4. Verifica que el comando MCP exista:

```bash
ls -l /srv/clawbrain/clawbraints/scripts/clawbrain-mcp-server-auto
```

5. Prueba arranque manual del server MCP:

```bash
cd /srv/clawbrain/clawbraints
./scripts/clawbrain-mcp-server-auto
```

6. Reinicia el cliente IDE (Cursor/VS Code) para recargar MCP.

## Validacion CLI (fuera del chat)

Para descartar problema del cliente IDE:

```bash
cd /srv/clawbrain/clawbraints
export CLAWBRAIN_IDE_SERVER_URL=http://127.0.0.1:8088
export CLAWBRAIN_IDE_TOKEN="$(cat /data/clawbrain/secrets/api_token)"
./scripts/clawbrain-ide agents
```
