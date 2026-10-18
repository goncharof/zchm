# Заклятье Чёрного мага: фронтенд + сервер сетевой игры в одном контейнере.
#   docker build -t zchm . && docker run -p 8787:8787 -v zchm-data:/data -e GEMINI_API_KEY=... zchm
#   (в образе только серверные зависимости: socket.io, sirv, zod, @anthropic-ai/sdk; фронтенд — уже собранный dist)
FROM node:24-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm build:server

FROM node:24-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data/rooms
# не от root: том с комнатами принадлежит пользователю node
RUN mkdir -p /data/rooms && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server-dist/index.js"]
