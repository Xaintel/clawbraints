# Implementacion Brain-Only

## Requisitos

- Docker Engine
- Docker Compose plugin
- Python 3 (para migraciones locales)
- Acceso a `/data/clawbrain` y `/srv/projects`

## Pasos de implementacion

### 1) Clonar repo

```bash
cd /srv
git clone <URL_REPO_BRAIN> clawbraints
cd /srv/clawbraints
```

### 2) Crear estructura persistente

```bash
sudo mkdir -p /srv/projects
sudo mkdir -p /data/clawbrain/{config,db,logs,memory,artifacts,secrets}
sudo chmod 700 /data/clawbrain/secrets
sudo chmod 777 /data/clawbrain/{db,logs,memory,artifacts}
```

### 3) Instalar templates activos

```bash
./scripts/install_config_templates.sh
```

### 4) Configurar token API

```bash
sudo sh -c 'openssl rand -hex 32 > /data/clawbrain/secrets/api_token'
sudo chmod 600 /data/clawbrain/secrets/api_token
```

### 5) Migrar DB

```bash
./scripts/migrate --db-path /data/clawbrain/db/clawbrain.sqlite3
```

### 6) Levantar stack

```bash
docker compose up -d --build
```

### 7) Validacion inicial

```bash
curl -fsS http://127.0.0.1:8088/health
TOKEN="$(cat /data/clawbrain/secrets/api_token)"
curl -fsS -H "X-Clawbrain-Token: $TOKEN" http://127.0.0.1:8088/api/ide/agents
./scripts/verify_brain.sh
```

## Configuracion de red recomendada

- Default seguro: bind local `127.0.0.1:8088`.
- Si expones a LAN/VPN, usar firewall por rango interno.
- No exponer este API a internet publica.

## Punto critico para tareas Codex

Para `type=codex`, el comando `codex` debe estar disponible dentro del contenedor runner.
Si no existe, el task quedara en `blocked` con artifact `run.sh` para ejecucion manual.

## Operacion diaria

```bash
# estado
docker compose ps

# logs API
docker compose logs -f clawbrain-api

# logs runner coder
docker compose logs -f runner-coder

# reinicio
docker compose restart

# detener
docker compose down
```
