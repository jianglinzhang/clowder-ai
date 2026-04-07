FROM node:20-slim
#启用 pnpm（pnpm9+）
RUN corepack enable && corepack prepare pnpm@9 --activate
#安装少量系统依赖（如果启用语音服务可能需要 Python）
RUN apt-get update && apt-get install -y --no-install-recommends \
 git \
 python3 \
 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
#复制所有文件（pnpm monorepo 需要完整的 workspace结构）
COPY . .


ENV NEXT_PUBLIC_API_URL=http://localhost:3004
#安装依赖 +构建
RUN pnpm install --frozen-lockfile
RUN pnpm build

# API端口（内部使用）
#生产环境配置（重要！）
ENV NODE_ENV=production
ENV API_SERVER_HOST=0.0.0.0
ENV ANTHROPIC_PROXY_ENABLED=1
ENV API_SERVER_PORT=3004

EXPOSE 3003
#启动命令：使用 production模式 + --memory（单容器无需 Redis，数据内存存储，重启会丢失）
CMD ["sh", "-c", "cp .env.example.opensource .env && node ./scripts/start-entry.mjs start:direct --profile=production --memory"]
