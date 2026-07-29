# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
FROM base AS runner
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
RUN addgroup --system --gid 1001 app && adduser --system --uid 1001 --ingroup app app
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --from=builder --chown=app:app /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/public ./public
COPY --chown=app:app scripts/validate-runtime-env.mjs ./scripts/validate-runtime-env.mjs
COPY --from=builder --chown=app:app /app/dist ./dist
USER app
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server.js"]
