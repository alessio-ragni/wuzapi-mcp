# Build stage: better-sqlite3 compiles from source when no prebuilt binary fits the platform.
FROM node:24-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data && chmod 755 /usr/local/bin/docker-entrypoint.sh
VOLUME /data
EXPOSE 3000
# Starts as root to fix the ownership of the mounted folders, then drops to an ordinary user.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/main.ts"]
