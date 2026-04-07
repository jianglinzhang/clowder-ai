FROM node:20-slim

# 启用 pnpm（pnpm9+）
RUN corepack enable \
 && corepack prepare pnpm@9 --activate

# 安装系统依赖
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    redis-server \
    nginx \
    tini \
 && rm -rf /var/lib/apt/lists/*

# Hugging Face Docker Space 官方建议使用 uid 1000 的用户
RUN useradd -m -u 1000 user

ENV HOME=/home/user
WORKDIR /home/user/app

# 复制项目
COPY --chown=user:user . .

# 安装依赖 + 构建
RUN pnpm install --frozen-lockfile
RUN pnpm build

# 创建持久化目录
RUN mkdir -p /data/redis
RUN mkdir -p /data/redis-backups
RUN mkdir -p /data/logs/api
RUN chown -R user:user /data

# 清理 nginx 默认配置
RUN rm -f /etc/nginx/sites-enabled/default
RUN rm -f /etc/nginx/conf.d/default.conf

# 写入 nginx 配置
RUN cat <<'EOF' > /etc/nginx/conf.d/clowder.conf
server {
    listen 7860;
    server_name _;

    client_max_body_size 50m;

    location /api/ {
        proxy_pass http://127.0.0.1:3004;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3004;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

# 写入启动脚本
RUN cat <<'EOF' > /usr/local/bin/docker-entrypoint.sh
#!/bin/sh
set -eu

mkdir -p /data/redis
mkdir -p /data/redis-backups
mkdir -p /data/logs/api
chown -R user:user /data

if [ ! -f /home/user/app/.env ]; then
cat <<'EOT' > /home/user/app/.env
FRONTEND_PORT=3003
API_SERVER_PORT=3004
REDIS_PORT=6399
REDIS_URL=redis://127.0.0.1:6399
REDIS_DATA_DIR=/data/redis
REDIS_BACKUP_DIR=/data/redis-backups
LOG_DIR=/data/logs/api
EOT
chown user:user /home/user/app/.env
fi

redis-server \
  --bind 127.0.0.1 \
  --port 6399 \
  --dir /data/redis \
  --dbfilename dump.rdb \
  --appendonly yes \
  --appendfilename appendonly.aof \
  --save 60 1000 \
  --daemonize yes

nginx

exec su user -s /bin/sh -c '
cd /home/user/app
export NODE_ENV=production
export API_SERVER_HOST=127.0.0.1
export FRONTEND_PORT="${FRONTEND_PORT:-3003}"
export API_SERVER_PORT="${API_SERVER_PORT:-3004}"
export REDIS_PORT="${REDIS_PORT:-6399}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6399}"
export REDIS_DATA_DIR="${REDIS_DATA_DIR:-/data/redis}"
export REDIS_BACKUP_DIR="${REDIS_BACKUP_DIR:-/data/redis-backups}"
export LOG_DIR="${LOG_DIR:-/data/logs/api}"
node ./scripts/start-entry.mjs start:direct --profile=production
'
EOF

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV FRONTEND_PORT=3003
ENV API_SERVER_PORT=3004
ENV REDIS_PORT=6399
ENV REDIS_URL=redis://127.0.0.1:6399
ENV REDIS_DATA_DIR=/data/redis
ENV REDIS_BACKUP_DIR=/data/redis-backups
ENV LOG_DIR=/data/logs/api
ENV API_SERVER_HOST=127.0.0.1
ENV ANTHROPIC_PROXY_ENABLED=0

EXPOSE 7860

VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/docker-entrypoint.sh"]
