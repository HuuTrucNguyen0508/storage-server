FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
COPY tools/install-corepack.mjs /tmp/install-corepack.mjs
RUN node /tmp/install-corepack.mjs && corepack enable
WORKDIR /app/api
COPY services/todo/api/package.json services/todo/api/pnpm-lock.yaml services/todo/api/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY services/todo/api/ ./
RUN pnpm build && pnpm prune --prod
COPY packages/ui /packages/ui
WORKDIR /app/web
COPY services/todo/web/ ./
RUN pnpm install --frozen-lockfile && pnpm build
FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
ENV NODE_ENV=production WEB_ROOT=/app/web/dist
WORKDIR /app/api
COPY --from=build /app/api/package.json ./
COPY --from=build /app/api/node_modules ./node_modules
COPY --from=build /app/api/dist ./dist
COPY --from=build /app/api/migrations ./migrations
COPY --from=build /app/web/dist /app/web/dist
USER 1000:1000
EXPOSE 8080 9464
CMD ["node","--import","./dist/src/telemetry.js","dist/src/main.js"]
