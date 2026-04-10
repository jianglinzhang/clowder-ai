#!/bin/bash
set -e

echo "Starting Clowder AI (Redis + API + Frontend) in background..."
# 将 Node 业务放在后台运行
pnpm start:direct &

# 给系统 10 秒钟时间启动 API 和 Frontend
# 防止 Nginx 刚启动时前端还没准备好，Hugging Face 探针访问到 502 导致判定失败
echo "Waiting for services to spin up..."
sleep 10

echo "Starting Nginx reverse proxy on port 7860 in foreground..."
# 将 Nginx 放在前台运行。
# 增加 -g "error_log /dev/stderr info;" 覆盖 Nginx 编译时自带的 log 路径，防止启动时报错
exec nginx -g "error_log /dev/stderr info;" -c /app/docker/nginx.conf
