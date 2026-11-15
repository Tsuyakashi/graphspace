# Graphspace: сервер без npm-зависимостей + собранный интерфейс. Craft монтируется томом в /craft.
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4680 \
    GRAPHSPACE_DATA=/data \
    GRAPHSPACE_CRAFT_DIR=/craft \
    GRAPHSPACE_SEED=0
WORKDIR /app
COPY package.json ./
COPY server/ server/
COPY seed/ seed/
COPY --from=web /app/web/dist web/dist
RUN mkdir -p /data /craft && chown node:node /data
USER node
VOLUME /data
EXPOSE 4680
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4680/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/index.mjs"]
