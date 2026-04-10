# 使用官方 Node 20 镜像 (Debian 基础镜像，包含充足的编译工具)
FROM node:20-bookworm-slim

# 安装系统级依赖：Redis 7+, Nginx, Git
RUN apt-get update && apt-get install -y \
    redis-server \
    nginx \
    git \
    && rm -rf /var/lib/apt/lists/*

# 启用 pnpm 9+
RUN corepack enable && corepack prepare pnpm@9 --activate

# Hugging Face 要求以 user 1000 运行。'node' 用户默认 UID 就是 1000。
# 创建并赋予所需目录的所有权，确保非 root 用户能正常写入
RUN mkdir -p /app/data /app/logs /tmp/client_body /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp \
    && chown -R node:node /app /tmp/client_body /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp /var/lib/nginx /var/log/nginx

WORKDIR /app
USER node

# 拷贝项目文件并设置权限
COPY --chown=node:node . .

# 复制默认环境变量配置
RUN cp .env.example .env

# =================环境变量配置=================
# 强制覆盖环境变量，使用空字符串覆盖 API_URL，
# 这样前端将自动使用相对路径，经由 Nginx 将请求完美转发。
ENV FRONTEND_PORT=3003
ENV API_SERVER_PORT=3004
ENV REDIS_PORT=6399
ENV REDIS_URL="redis://127.0.0.1:6399"
# ENV NEXT_PUBLIC_API_URL=""

# 如果你不需要 Redis 数据持久化，可以取消注释下面这行开启纯内存模式
# ENV START_ARGS="--memory" 
# ============================================

# 安装 Node 依赖
RUN pnpm install

# 编译所有包 (Next.js 等)
RUN pnpm build

# 授予启动脚本执行权限
RUN chmod +x /app/docker/entrypoint.sh

# 暴露给云平台的单一通信端口
EXPOSE 7860

# 指定启动入口
ENTRYPOINT ["/app/docker/entrypoint.sh"]
