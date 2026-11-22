FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

ENV PORT=3000 \
    NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

# git + curl: the builder agent shells out to them (git push, healthcheck curls).
# @railway/cli: bundled CLI for the build loop's publish SOP — installed WITH
# scripts (its postinstall unpacks the statically-linked musl binary; Linux npm
# works fine — quirk 61i is Windows-only). better-sqlite3 quirk 33a: the APP
# install stays --ignore-scripts + prebuild smoke test so ABI drift fails HERE.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && (node -e "const D=require('better-sqlite3');new D(':memory:').exec('select 1')" \
   || (npm rebuild better-sqlite3 && node -e "const D=require('better-sqlite3');new D(':memory:').exec('select 1')"))

RUN apk add --no-cache git curl su-exec \
 && npm install -g --foreground-scripts @railway/cli@5.75.0 \
 && railway --version

COPY src/ ./src/
COPY public/ ./public/

RUN chmod +x /app/src/entrypoint.sh \
 && mkdir -p /data && chown node:node /app /data

EXPOSE 3000

# Entrypoint chowns the (root-owned on Railway) /data volume to node, then drops
# privileges so the server (and the agent's shells) never run as root.
ENTRYPOINT ["/app/src/entrypoint.sh"]
