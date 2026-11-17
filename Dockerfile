# syntax=docker/dockerfile:1
# Graphspace: сервер (одна зависимость — pg) + собранный интерфейс + веб-сборки Craft.
# Данные — в Postgres и S3, в контейнере только кэш превью.
# Версии Craft — craft-versions.json; в CI они же попадают в label graphspace.craft.

FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM debian:trixie-slim AS craft
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY craft-versions.json setup-craft.sh ./
# Токен необязателен (лимит API), в слои не попадает.
RUN --mount=type=secret,id=gh_token,env=GITHUB_TOKEN ./setup-craft.sh

FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4680 \
    GRAPHSPACE_DATA=/data \
    GRAPHSPACE_CRAFT_DIR=/craft \
    GRAPHSPACE_SEED=0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/ server/
COPY seed/ seed/
COPY --from=web /app/web/dist web/dist
COPY --from=craft /src/craft /craft
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4680
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4680/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/index.mjs"]
