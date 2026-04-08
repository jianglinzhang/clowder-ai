#!/usr/bin/env bash
set -euo pipefail

cd /app

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
fi

mkdir -p /app/data /data/redis

exec node /opt/manager/server.js
