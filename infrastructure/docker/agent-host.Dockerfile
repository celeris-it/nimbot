# Agent Host image: OpenCode + the Nimbot agent-host, running as a non-root user.
# Build from the repo root:
#   docker build -f infrastructure/docker/agent-host.Dockerfile -t nimbot-agent-host .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g opencode-ai pnpm@10

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/agent-host apps/agent-host
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @nimbot/agent-host build \
 && pnpm --filter @nimbot/agent-host exec playwright install --with-deps chromium \
 && chmod -R a+rX /opt/playwright \
 && rm -rf /var/lib/apt/lists/*

# The base image ships a non-root "node" user (uid 1000).
RUN mkdir -p /workspace /home/node/.local/share/opencode \
 && chown -R node:node /workspace /home/node/.local
USER node
ENV WORKSPACE=/workspace
VOLUME /workspace
WORKDIR /workspace

ENTRYPOINT ["node", "/app/apps/agent-host/dist/demo.js"]
