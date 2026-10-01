# syntax=docker/dockerfile:1.7

# ---- Build -------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# better-sqlite3 falls back to compiling from source when no prebuilt binary fits.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
RUN npm run build

# ---- Production dependencies -------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# ---- Runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/kamoras/hues-and-cues-twitch" \
      org.opencontainers.image.description="Hues & Cues colour-guessing game for Twitch" 
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/dist/public
WORKDIR /app

RUN mkdir -p /data && chown node:node /data
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "dist/node/server/index.js"]
