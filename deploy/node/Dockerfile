FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216
WORKDIR /app/cloudflare
COPY cloudflare/main.mjs ./src/node/main.mjs
COPY cloudflare/.cloudflare/output/v0/workers/default/assets ./.cloudflare/output/v0/workers/default/assets
USER node
ENV STATS_DATA_DIR=/data STATS_LISTEN=unix:/run/stats/stats.sock
STOPSIGNAL SIGTERM
CMD ["node", "src/node/main.mjs"]
