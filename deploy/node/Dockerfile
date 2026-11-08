FROM node:26.13.0-alpine
WORKDIR /app/cloudflare
COPY cloudflare/package.json ./package.json
COPY cloudflare/src ./src
COPY cloudflare/.cloudflare/output/v0/workers/default/assets ./.cloudflare/output/v0/workers/default/assets
USER node
ENV STATS_DATA_DIR=/data STATS_LISTEN=unix:/run/stats/stats.sock
STOPSIGNAL SIGTERM
CMD ["node", "--experimental-strip-types", "src/node/main.ts"]
