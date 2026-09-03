# syntax=docker/dockerfile:1

########################################
# Stage 1 — builder
# Compiles native deps (better-sqlite3) once, with a full toolchain.
########################################
FROM node:20-bookworm-slim AS builder

# Build tools required to compile better-sqlite3's native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies against the pinned Node version.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

########################################
# Stage 2 — runtime
# Clean image with no compilers; just Node + app + prebuilt node_modules.
########################################
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/a3shipping.sqlite

WORKDIR /app

# Copy compiled dependencies and application source.
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# Persistent SQLite location; owned by the unprivileged runtime user.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 3000

# Container-native health check hitting the existing endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
