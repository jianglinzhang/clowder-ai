FROM node:20-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    redis-server \
    bash \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY . .

# 没有 .env 时，先复制一个，避免某些构建脚本读取失败
RUN if [ ! -f .env ] && [ -f .env.example ]; then cp .env.example .env; fi

RUN pnpm install --frozen-lockfile
RUN pnpm build

# 安装管理面板依赖
WORKDIR /opt/manager
COPY docker/manager/package.json /opt/manager/package.json
RUN npm install --omit=dev
COPY docker/manager /opt/manager


FROM node:20-bookworm-slim AS runtime

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    redis-server \
    bash \
    procps \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY --from=build /app /app
COPY --from=build /opt/manager /opt/manager
COPY docker/entrypoint.sh /entrypoint.sh

RUN mkdir -p /app/data /data/redis \
    && chmod +x /entrypoint.sh \
    && chown -R node:node /app /opt/manager /data /entrypoint.sh

ENV NODE_ENV=production
ENV APP_ROOT=/app

# 外部平台只暴露一个端口，默认 7860
ENV PORT=7860

# 项目内部端口
ENV FRONTEND_PORT=3003
ENV API_SERVER_PORT=3004
ENV REDIS_PORT=6399

# 容器启动后自动拉起主程序
ENV AUTO_START=1

# 默认
ENV APP_START_CMD="pnpm start"

# 管理面板路径
ENV ADMIN_BASE_PATH=/admin

# 默认禁用任意 shell，自定义命令可手动开启
ENV ADMIN_ENABLE_SHELL=1

# 建议你在部署平台里设置这个
# ENV ADMIN_TOKEN=change-me

USER node

EXPOSE 7860

ENTRYPOINT ["dumb-init", "--"]
CMD ["/entrypoint.sh"]
