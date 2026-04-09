FROM node:20-bookworm-slim AS runtime

ENV PNPM_HOME=/pnpm
ENV PATH=/opt/venv/bin:$PNPM_HOME:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    redis-server \
    bash \
    procps \
    dumb-init \
    nginx \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/venv/bin/pip install --no-cache-dir flask==3.0.3

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY --from=build /app /app
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/manager.py /opt/manager.py
COPY docker/nginx.conf /etc/nginx/nginx.conf

RUN chmod +x /entrypoint.sh \
    && mkdir -p /var/lib/nginx /var/log/nginx /run/nginx

ENV NODE_ENV=production
ENV APP_ROOT=/app
ENV PORT=7860
ENV FRONTEND_PORT=3003
ENV API_SERVER_PORT=3004
ENV REDIS_PORT=6399
ENV MANAGER_PORT=7861
ENV AUTO_START=1
ENV APP_START_CMD="pnpm start:direct"
ENV ADMIN_ENABLE_SHELL=0
ENV MAX_LOG_LINES=5000

EXPOSE 7860

ENTRYPOINT ["dumb-init", "--", "/entrypoint.sh"]
