# syntax=docker/dockerfile:1

# ---------- Stage 1: build the TypeScript SPA ----------
FROM node:22-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---------- Stage 2: Python runtime ----------
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8270
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/arrlink ./arrlink
COPY --from=web /build/dist ./web/dist
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
    && useradd --uid 1000 --create-home appuser \
    && mkdir -p /config /linked

EXPOSE 8270

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,sys,urllib.request; p=os.environ.get('PORT','8270'); r=urllib.request.urlopen(f'http://127.0.0.1:{p}/api/health',timeout=3); sys.exit(0 if r.status==200 else 1)"

ENTRYPOINT ["/entrypoint.sh"]
