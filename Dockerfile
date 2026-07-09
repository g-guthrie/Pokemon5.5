# Showdown LLM Arena — production image.
# The vendored Showdown simulator + client must be built inside the image so
# the container is self-contained (no host node_modules leak in).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY vendor ./vendor
RUN npm --prefix vendor/pokemon-showdown install \
 && npm --prefix vendor/pokemon-showdown run build \
 && npm --prefix vendor/pokemon-showdown-client install \
 && npm --prefix vendor/pokemon-showdown-client run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/vendor ./vendor
COPY package.json ./
COPY src ./src
COPY public ./public

# Replays/artifacts live here; mount a volume to persist them across deploys.
RUN mkdir -p artifacts/live-runs && chown -R node:node /app
USER node
VOLUME ["/app/artifacts"]

ENV PORT=8123
# Behind a reverse proxy that sets x-forwarded-for, enable TRUST_PROXY=1 so
# rate limits apply per visitor instead of per proxy.
# ENV TRUST_PROXY=1
# ENV MAX_CONCURRENT_RUNS=3
# ENV MAX_LIVE_ARTIFACTS=400

EXPOSE 8123
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8123)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
