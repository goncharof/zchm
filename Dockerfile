# Заклятье Чёрного мага: фронтенд + сервер сетевой игры в одном контейнере.
#   docker build -t zchm . && docker run -p 8787:8787 -v zchm-data:/data -e ANTHROPIC_API_KEY=... zchm
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
VOLUME /data
EXPOSE 8787
CMD ["node", "server-dist/index.js"]
