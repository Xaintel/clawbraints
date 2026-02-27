# Guia de Levantamiento - Rama `mobile`

Esta guia deja operativo el Brain local y su consumo remoto desde tu PC de la pega.

## 1) Preparar host (WSL Ubuntu)

Instala dependencias base:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git python3 curl ca-certificates gnupg
```

Arranca Docker y habilita permisos:

```bash
sudo service docker start
sudo usermod -aG docker "$USER"
newgrp docker
```

Valida Docker:

```bash
docker version
docker compose version
docker run --rm hello-world
```

## 2) Instalar Codex CLI + login por sesion

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g @openai/codex
codex login --device-auth
codex login status
```

Nota: no necesitas `OPENAI_API_KEY` si `codex login status` muestra sesion activa.

## 3) Clonar y levantar rama `mobile`

```bash
mkdir -p ~/Proyecto
cd ~/Proyecto
git clone https://github.com/Xaintel/clawbrain.git
cd clawbrain
git fetch origin
git switch mobile || git switch -c mobile --track origin/mobile
git pull --ff-only
```

Levantar Brain local:

```bash
cd ~/Proyecto/clawbrain
# Si quieres usar todos tus repos de ~/Proyecto dentro de /srv/projects:
export CLAWBRAIN_LOCAL_PROJECTS_ROOT="$HOME/Proyecto"
# Opcional: subir timeout para tareas codex largas
export CLAWBRAIN_COMMAND_TIMEOUT_SEC=900
./scripts/local_up.sh
./scripts/verify_brain_local.sh
```

API local por defecto: `http://127.0.0.1:18088`

Notas importantes:
- No uses URL con `/tree/mobile` al clonar (`git clone` solo acepta URL del repo).
- Si `clawbrain` ya existe localmente, no vuelvas a clonar: entra al repo y haz `git fetch && git switch mobile`.
- La policy local se regenera en cada `local_up.sh` segun los repos detectados.

## 4) Exponer Brain para usarlo desde tu PC de la pega

En el host donde corre el Brain:

```bash
cd ~/Proyecto/clawbrain
CLAWBRAIN_LOCAL_API_BIND=0.0.0.0:18088 ./scripts/local_up.sh
hostname -I
cat .local/data/secrets/api_token
```

Guarda:
- `IP_HOST`: una IP accesible en tu red
- `TOKEN`: contenido de `.local/data/secrets/api_token`

## 5) Consumir Brain desde tu PC de la pega

En el cliente (tu PC de la pega):

```bash
git clone https://github.com/Xaintel/clawbrain.git
cd clawbrain
git fetch origin
git switch mobile || git switch -c mobile --track origin/mobile

export CLAWBRAIN_IDE_SERVER_URL="http://IP_HOST:18088"
export CLAWBRAIN_IDE_TOKEN="TOKEN"
./scripts/clawbrain-ide agents
```

Smoke task remoto:

```bash
./scripts/clawbrain-ide create-task \
  --type command \
  --repo demo \
  --agent BuilderAgent \
  --command 'python3 -c "print(123)"' \
  --request-text 'smoke remoto'
```

Si exportaste `CLAWBRAIN_LOCAL_PROJECTS_ROOT="$HOME/Proyecto"` al levantar, tambien puedes usar repos reales por nombre:

```bash
./scripts/clawbrain-ide create-task \
  --type codex \
  --repo claw-jira-app \
  --agent CoderAgent \
  --request-text 'smoke codex en repo real'
```

## 6) MCP para Codex Chat en IDE (Cursor/VS Code)

En el cliente:

```bash
cat > .env.mcp.work <<EOF
CLAWBRAIN_IDE_SERVER_URL=http://IP_HOST:18088
CLAWBRAIN_IDE_TOKEN=TOKEN
EOF
export CLAWBRAIN_MCP_ENV_FILE="$PWD/.env.mcp.work"
./scripts/clawbrain-mcp-server-auto
```

Config MCP del IDE:

```json
{
  "mcpServers": {
    "clawbrain": {
      "command": "/ruta/a/clawbrain/scripts/clawbrain-mcp-server-auto"
    }
  }
}
```

## 7) Operacion diaria

```bash
# levantar
./scripts/local_up.sh

# verificar
./scripts/verify_brain_local.sh

# bajar
./scripts/local_down.sh
```
