FROM node:26.12.1-alpine
WORKDIR /app/cloudflare
COPY cloudflare/package.json ./package.json
COPY cloudflare/src ./src
COPY cloudflare/.cloudflare/output/v0/workers/default/assets ./.cloudflare/output/v0/workers/default/assets
USER node
ENV STATS_DATA_DIR=/data STATS_LISTEN=127.0.0.1:18791
STOPSIGNAL SIGTERM
CMD ["node", "--experimental-strip-types", "src/node/main.ts"]
