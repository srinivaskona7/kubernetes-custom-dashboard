# syntax=docker/dockerfile:1

# Build Stage — install deps, build React + TypeScript frontend
FROM docker.apple.com/base-images/ubi9/node22-builder:latest AS build
WORKDIR /app

COPY .npmrc ./
COPY package*.json ./

# Install all deps (need devDependencies for vite build)
RUN npm ci --registry=https://npm.apple.com

COPY src/ ./src/
COPY index.html ./
COPY vite.config.js ./
COPY tsconfig.json ./
COPY server/ ./server/

# Build frontend with /btp-kyma-fleet-dashboard/ base path for production
RUN VITE_BASE_PATH=/btp-kyma-fleet-dashboard/ npx vite build

# Prune devDependencies for runtime
RUN npm prune --omit=dev

# Runtime Stage — minimal image, non-root user
FROM docker.apple.com/base-images/ubi9-minimal/node22-runtime:latest
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

ENV http_proxy="http://proxy.config.pcp.local:3128/"
ENV https_proxy="http://proxy.config.pcp.local:3128/"
ENV HTTP_PROXY="http://proxy.config.pcp.local:3128/"
ENV HTTPS_PROXY="http://proxy.config.pcp.local:3128/"
ENV NO_PROXY="0.0.0.0,localhost,127.0.0.1,172.31.94.0/24,172.31.80.0/22,172.31.84.0/22,172.18.100.0/23,100.120.57.160/27,172.31.93.0/24,172.18.104.0/23,100.120.89.160/27,172.18.102.0/23,172.31.88.0/22,100.120.73.160/27,172.31.92.0/24,.internal,.apple.com"
ENV no_proxy="0.0.0.0,localhost,127.0.0.1,172.31.94.0/24,172.31.80.0/22,172.31.84.0/22,172.18.100.0/23,100.120.57.160/27,172.31.93.0/24,172.18.104.0/23,100.120.89.160/27,172.18.102.0/23,172.31.88.0/22,100.120.73.160/27,172.31.92.0/24,.internal,.apple.com"

USER root
RUN mkdir -p /logs && chown $NON_ROOT_USER:$NON_ROOT_USER /logs
# SQLite data dir — the PVC (chart persistence) mounts over this at runtime;
# create + chown it here so the dir also exists (and is writable) without a PVC.
RUN mkdir -p /app/data && chown $NON_ROOT_USER:$NON_ROOT_USER /app/data
USER $NON_ROOT_USER

# Copy production node_modules and server code (server/fleet/clusters.json, the baked
# cluster registry, travels with server/).
# better-sqlite3 is a native module compiled in the build stage against the same
# UBI9 node22 base-image family, so the binding carries over unchanged.
COPY --chown=$NON_ROOT_USER:$NON_ROOT_USER --from=build /app/node_modules ./node_modules
COPY --chown=$NON_ROOT_USER:$NON_ROOT_USER --from=build /app/package.json ./package.json
COPY --chown=$NON_ROOT_USER:$NON_ROOT_USER --from=build /app/server ./server

# Copy built frontend
COPY --chown=$NON_ROOT_USER:$NON_ROOT_USER --from=build /app/dist ./dist

# Copy seed data — loadDb() seeds the SQLite books table from it when empty
COPY --chown=$NON_ROOT_USER:$NON_ROOT_USER config/ ./config/

# Copy entrypoint
COPY --chown=$NON_ROOT_USER:$NON_ROOT_USER entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

EXPOSE 3001

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "server/index.js"]
