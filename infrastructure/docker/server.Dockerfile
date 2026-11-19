FROM docker:28-cli AS docker-cli
FROM node:22-bookworm-slim AS server
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY scripts/state-schema.mjs scripts/state-schema.d.mts scripts/
COPY scripts/state-schema/ scripts/state-schema/
COPY apps/server apps/server
COPY apps/panel apps/panel
RUN npm install -g pnpm@10 \
 && pnpm install --frozen-lockfile \
 && pnpm --filter @nimbot/panel build \
 && pnpm --filter @nimbot/server build
RUN mkdir -p /home/node/.local/share/nimbot \
 && chown -R node:node /home/node/.local
USER node
ENV PANEL_HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]

FROM server AS upgrade
USER root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY scripts/upgrade*.mjs scripts/

FROM server AS runtime
