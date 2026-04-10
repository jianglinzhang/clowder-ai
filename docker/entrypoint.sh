#!/bin/bash
set -e

echo "Starting Nginx reverse proxy on port 7860..."
# 后台启动 Nginx
nginx -c /app/docker/nginx.conf &

echo "Starting Clowder AI (Redis + API + Frontend)..."
# 使用 start:direct 绕过 worktree 检查，直接在当前容器目录下启动所有业务
exec pnpm start:direct
