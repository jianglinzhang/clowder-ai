FROM node:20-slim

# 启用 pnpm
RUN corepack enable
RUN corepack prepare pnpm@9 --activate

# 安装系统依赖
RUN apt-get update
RUN apt-get install -y --no-install-recommends \
 git \
 python3 \
 python3-pip \
 redis-server \
 tini \
 bash
RUN rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制项目
COPY . .

# 安装依赖
RUN pnpm install --frozen-lockfile

# 构建
RUN pnpm build

# 生产环境
ENV NODE_ENV=production
ENV FRONTEND_HOST=0.0.0.0
ENV FRONTEND_PORT=3003
ENV API_SERVER_HOST=0.0.0.0
ENV API_SERVER_PORT=3004
ENV REDIS_PORT=6399
ENV REDIS_URL=redis://127.0.0.1:6399
ENV REDIS_DATA_DIR=/data/redis
ENV REDIS_BACKUP_DIR=/data/redis-backups
ENV LOG_DIR=/data/logs/api
ENV ANTHROPIC_PROXY_ENABLED=0

# 给 Node 更大的堆
# 如果平台内存小，可以改成 1024 或 1536
ENV NODE_OPTIONS=--max-old-space-size=2048

# 数据卷
VOLUME ["/data"]

# 暴露端口
EXPOSE 3003
EXPOSE 3004
EXPOSE 6399

# 写启动脚本
RUN cat <<'EOF' > /usr/local/bin/docker-entrypoint.sh
#!/bin/bash
set -e

mkdir -p /data/redis
mkdir -p /data/redis-backups
mkdir -p /data/logs/api

if [ ! -f /app/.env ]; then
  cp /app/.env.example /app/.env
fi

exec bash ./scripts/start-dev.sh \
  --prod-web \
  --profile=production \
  --quick
EOF

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/docker-entrypoint.sh"]
