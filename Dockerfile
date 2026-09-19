# Node 24 可直接运行项目中的 TypeScript；运行镜像只安装生产依赖。
FROM node:24-alpine AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8100 \
    MAX_CONCURRENCY=8

WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node src ./src

EXPOSE 8100
USER node
ENTRYPOINT ["node", "src/http/server.ts"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
