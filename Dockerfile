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
 tini
RUN rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制项目文件
COPY . .

# 安装依赖
RUN pnpm install --frozen-lockfile

# 构建项目
RUN pnpm build

# 创建数据目录
RUN mkdir -p /data/redis
RUN mkdir -p /data/redis-backups
RUN mkdir -p /data/logs/api

# 调整权限给 node 用户
RUN chown -R node:node /app
RUN chown -R node:node /data

# 生产环境变量
ENV NODE_ENV=production
ENV FRONTEND_HOST=0.0.0.0
ENV FRONTEND_PORT=3003
ENV API_SERVER_HOST=0.0.0.0
ENV API_SERVER_PORT=3004
ENV REDIS_HOST=127.0.0.1
ENV REDIS_PORT=6399
ENV REDIS_URL=redis://127.0.0.1:6399
ENV REDIS_DATA_DIR=/data/redis
ENV REDIS_BACKUP_DIR=/data/redis-backups
ENV LOG_DIR=/data/logs/api
ENV ANTHROPIC_PROXY_ENABLED=0

# 切换到 node 用户运行
USER node

# 暴露常用端口
EXPOSE 3003
EXPOSE 3004
EXPOSE 6399

# 数据卷
VOLUME ["/data"]

# 启动
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "\
if [ ! -f .env ]; then \
  cp .env.example .env || true; \
fi; \
redis-server \
  --bind 127.0.0.1 \
  --port 6399 \
  --dir /data/redis \
  --dbfilename dump.rdb \
  --appendonly yes \
  --appendfilename appendonly.aof \
  --save 60 1000 \
  --pidfile /tmp/redis.pid \
  --daemonize yes; \
node ./scripts/start-entry.mjs start:direct --profile=production \
"]
