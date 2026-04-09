#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[entrypoint] $*"
}

set_kv() {
  local key="$1"
  local val="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
}

log "boot start"
cd /app
log "cwd=$(pwd)"
log "whoami=$(whoami)"
log "PORT=${PORT:-}"
log "FRONTEND_PORT=${FRONTEND_PORT:-}"
log "API_SERVER_PORT=${API_SERVER_PORT:-}"
log "REDIS_PORT=${REDIS_PORT:-}"
log "MANAGER_PORT=${MANAGER_PORT:-}"

if [ ! -f .env ] && [ -f .env.example ]; then
  log "copy .env.example -> .env"
  cp .env.example .env
fi

touch .env
set_kv FRONTEND_PORT "${FRONTEND_PORT:-3003}"
set_kv API_SERVER_PORT "${API_SERVER_PORT:-3004}"
set_kv REDIS_PORT "${REDIS_PORT:-6399}"
set_kv NEXT_PUBLIC_API_URL "/api"

log "effective .env:"
cat .env || true

if [ -n "${MCP_JSON_B64:-}" ]; then
  log "write /app/.mcp.json from MCP_JSON_B64"
  echo "$MCP_JSON_B64" | base64 -d > /app/.mcp.json
elif [ ! -f /app/.mcp.json ]; then
  log "create default /app/.mcp.json"
  cat >/app/.mcp.json <<'EOF'
{
  "mcpServers": {}
}
EOF
fi

DATA_ROOT="${PERSIST_ROOT:-}"
if [ -z "${DATA_ROOT}" ]; then
  if mkdir -p /data/clowder-ai >/dev/null 2>&1; then
    DATA_ROOT="/data/clowder-ai"
    log "using DATA_ROOT=${DATA_ROOT}"
  else
    DATA_ROOT="/app/data"
    log "/data not writable, fallback DATA_ROOT=${DATA_ROOT}"
  fi
fi

mkdir -p "${DATA_ROOT}"
mkdir -p "${DATA_ROOT}/redis"
mkdir -p "${DATA_ROOT}/logs"
mkdir -p /app/packages/api/data/connector-media

if [ "${DATA_ROOT}" != "/app/data" ]; then
  log "link /app/data -> ${DATA_ROOT}"
  rm -rf /app/data || true
  ln -s "${DATA_ROOT}" /app/data
else
  mkdir -p /app/data
fi

log "ls -la /app"
ls -la /app || true
log "ls -la /app/data"
ls -la /app/data || true
log "ls -la /app/packages/api/data"
ls -la /app/packages/api/data || true

log "start flask manager"
python3 -u /opt/manager.py &
MANAGER_PID=$!
log "manager pid=${MANAGER_PID}"

sleep 1

log "nginx -t"
nginx -t

log "start nginx foreground"
exec nginx -g 'daemon off;'
