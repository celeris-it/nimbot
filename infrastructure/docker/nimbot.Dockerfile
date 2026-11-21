# One non-root application container: Server, panel, OpenCode and Agent Hosts.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @opencode/cli@2.2.7 pnpm@10.33.0

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/panel/package.json apps/panel/package.json
COPY apps/agent-host/package.json apps/agent-host/package.json
RUN chmod -R a+rX /app \
 && pnpm install --frozen-lockfile \
 && pnpm --filter @nimbot/agent-host exec playwright install --with-deps chromium \
 && chmod -R a+rX /opt/playwright \
 && rm -rf /var/lib/apt/lists/*

COPY scripts/state-schema.mjs scripts/state-schema.d.mts scripts/
COPY scripts/state-schema/ scripts/state-schema/
COPY apps/server apps/server
COPY apps/panel apps/panel
COPY apps/agent-host apps/agent-host
RUN chmod -R a+rX scripts apps \
 && pnpm build \
 && mkdir -p /data \
 && chown node:node /data \
 && chmod 700 /data

USER node
ENV NIMBOT_MODE=docker
ENV SERVER_STATE_DIR=/data
ENV PANEL_HOST=0.0.0.0
ENV PANEL_PORT=3000
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login', {signal: AbortSignal.timeout(3000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/server/dist/index.js"]
