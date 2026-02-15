ARG NODE_IMAGE=node:20-alpine

FROM ${NODE_IMAGE} AS base
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm install --prod=false --frozen-lockfile=false
RUN pnpm --filter @curly-broccoli/shared build && pnpm --filter @curly-broccoli/api build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --prod --frozen-lockfile=false

COPY --from=base /app/packages/shared/dist packages/shared/dist
COPY --from=base /app/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations

WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/index.js"]
