FROM node:lts-trixie-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
# Whole tree: workspace may contain only a subset of adapters in a given checkout.
COPY packages/adapters packages/adapters

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @hive/shared build \
  && pnpm --filter @hive/adapter-utils build \
  && pnpm --filter @hive/db build \
  && pnpm --filter @hive/plugin-sdk build \
  && pnpm --filter @hive/ui build \
  && pnpm --filter @hive/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
# Node must resolve workspace packages to dist/; dev exports point at src/*.ts.
RUN node -e "const fs=require('fs'); for (const pkg of ['packages/db','packages/shared','packages/adapter-utils','packages/plugin-sdk']) { const p=JSON.parse(fs.readFileSync(pkg+'/package.json','utf8')); if (p.publishConfig && p.publishConfig.exports) p.exports = p.publishConfig.exports; fs.writeFileSync(pkg+'/package.json', JSON.stringify(p,null,2)+'\n'); }"

FROM base AS production
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && mkdir -p /hive \
  && chown node:node /hive

ENV NODE_ENV=production \
  HOME=/hive \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  HIVE_HOME=/hive \
  HIVE_INSTANCE_ID=default \
  HIVE_CONFIG=/hive/instances/default/config.json \
  HIVE_DEPLOYMENT_MODE=authenticated \
  HIVE_DEPLOYMENT_EXPOSURE=private

VOLUME ["/hive"]
EXPOSE 3100

USER node
CMD ["node", "server/dist/index.js"]
