# syntax=docker/dockerfile:1

# ---------- Stage 1: build the TypeScript SPA ----------
FROM node:22-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---------- Stage 2: build the TypeScript backend ----------
FROM node:22-alpine AS backend
WORKDIR /build
COPY backend-ts/package.json backend-ts/package-lock.json* ./
RUN npm install
COPY backend-ts/ ./
RUN npm run build

# ---------- Stage 3: runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8270
WORKDIR /app

RUN apk add --no-cache su-exec

COPY backend-ts/package.json backend-ts/package-lock.json* ./
RUN npm install --omit=dev

COPY --from=backend /build/dist ./dist
COPY --from=web /build/dist ./web/dist
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
    && adduser -D -u 1000 appuser \
    && mkdir -p /config /linked

EXPOSE 8270

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'8270')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
