#!/usr/bin/env bash
set -euo pipefail

cd /app

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
fi

# 自动生成最小可用的 .mcp.json
if [ ! -f /app/.mcp.json ]; then
  cat >/app/.mcp.json <<'EOF'
{
  "mcpServers": {}
}
EOF
fi

# 优先持久化目录
DATA_ROOT="${PERSIST_ROOT:-}"

if [ -z "${DATA_ROOT}" ]; then
  if mkdir -p /data/clowder-ai >/dev/null 2>&1; then
    DATA_ROOT="/data/clowder-ai"
  else
    DATA_ROOT="/app/data"
  fi
fi

mkdir -p "${DATA_ROOT}"

if [ "${DATA_ROOT}" != "/app/data" ]; then
  rm -rf /app/data
  ln -s "${DATA_ROOT}" /app/data
fi

mkdir -p /app/data
mkdir -p /app/data/redis
mkdir -p /app/data/logs

chown -R node:node /app /opt/manager "${DATA_ROOT}" || true

exec gosu node node /opt/manager/server.js
