# The API only (spec 0001 §9.4). The dashboard is a separate static SPA with its
# own deployment at its own domain, so nothing here references apps/admin.
# Build from the repo root: `docker build -f apps/api/Dockerfile .`

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY packages/contract-fixtures/package.json packages/contract-fixtures/
# Hoisted linker: everything lands in the root node_modules, which is the one
# directory the runtime stage copies. Bun's default isolated layout would
# scatter per-workspace node_modules the copy below misses.
RUN bun install --frozen-lockfile --production --linker=hoisted

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/lever.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/api ./apps/api

RUN mkdir -p /data && chown -R bun:bun /data

USER bun
EXPOSE 3000
VOLUME /data

# Shell form so PORT resolves at check time.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "fetch(\`http://127.0.0.1:\${process.env.PORT ?? 3000}/healthz\`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "run", "apps/api/src/index.ts"]
