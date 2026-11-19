FROM node:22-bookworm-slim
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
