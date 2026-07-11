# Showdown LLM Arena — production image.
# The Showdown simulator + client are pinned and built inside the image so a
# fresh GitHub checkout is sufficient; vendor/ remains a local-only cache.
FROM node:22-slim AS build
WORKDIR /app
ARG SHOWDOWN_COMMIT=84636bcc780f5bfcf91985f210d5c1bec9bb43ae
ARG SHOWDOWN_CLIENT_COMMIT=6d6e8748a66e9e5c9e0246296a52e73a7868b581
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN mkdir -p vendor \
 && git clone --filter=blob:none https://github.com/smogon/pokemon-showdown.git vendor/pokemon-showdown \
 && git -C vendor/pokemon-showdown checkout "$SHOWDOWN_COMMIT" \
 && git clone --filter=blob:none https://github.com/smogon/pokemon-showdown-client.git vendor/pokemon-showdown-client \
 && git -C vendor/pokemon-showdown-client checkout "$SHOWDOWN_CLIENT_COMMIT" \
 && rm -rf vendor/pokemon-showdown/.git vendor/pokemon-showdown-client/.git
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
