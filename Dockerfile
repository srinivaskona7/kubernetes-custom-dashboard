# syntax=docker/dockerfile:1
#
# Public images only — no corporate registry, no private base layers.
# Works unchanged on EKS, AKS, GKE, kind and bare-metal clusters.

# ─────────────────────────────────────────────────────────────────────────────
# Build stage — install deps, build the React + TypeScript frontend.
#
# better-sqlite3 is a native addon. It is compiled here so the loadable binding
# is produced against the same musl toolchain the runtime stage uses; the build
# tools themselves are not carried into the final image.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS build
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.js index.html ./
COPY src/ ./src/
COPY server/ ./server/

# Empty base path: the app is served from the root of the Ingress/host.
# Override at build time for a sub-path deployment, e.g.
#   --build-arg VITE_BASE_PATH=/fleet-dashboard/
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH
RUN npm run build

# Drop devDependencies so the runtime layer carries only what the server loads.
RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
# Runtime stage — minimal, non-root, health-checked.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    DB_PATH=/app/data/app.db

# The `node` user (uid 1000) ships with the official image. Create the writable
# directories it needs and hand them over before dropping privileges.
RUN mkdir -p /app/data /logs \
 && chown -R node:node /app/data /logs

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --chown=node:node config/ ./config/

USER node

EXPOSE 3001

# Node is the only interpreter guaranteed to exist in this image; no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
