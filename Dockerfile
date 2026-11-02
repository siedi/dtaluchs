# Image for dtaluchs: server with user interface and import, data under /data.
# Build with ./dtaluchs image, run with compose.yaml.

# Frontend: built on the native platform of the build host, the output is the same for every architecture
FROM --platform=$BUILDPLATFORM node:24-slim AS web
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# Python environment: dtaluchs as a package in /app/.venv, without source tree and without uv
FROM python:3.14-slim AS venv
COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /bin/
# Bytecode at build time, because the root file system may be read-only at runtime
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1
WORKDIR /src
# Dependencies first, so a change to the code does not reinstall them
COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./
RUN uv sync --locked --no-dev --no-install-project
COPY backend/src ./src
RUN uv sync --locked --no-dev --no-editable

# Runtime: the same base as the Python environment, the venv points to its interpreter
FROM python:3.14-slim
# /data belongs to the image's user; a mounted folder needs the same owner
RUN mkdir /data && chown 10001:10001 /data
COPY --from=venv /app/.venv /app/.venv
COPY --from=web /src/dist /app/web
# Settings only from the environment, the container does not read a dtaluchs.toml.
# DTA_SOURCE_DIR is set by compose.yaml, together with the volume /dta.
ENV PATH=/app/.venv/bin:$PATH \
    DATA_DIR=/data \
    FRONTEND_DIST=/app/web \
    HOST=0.0.0.0 \
    PORT=8470 \
    PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8470
# GET / returns index.html and needs no import; any error ends with code 1. Every 2 s during the first 60 s,
# so healthy comes shortly after start: the Home Assistant Supervisor waits for it on start
HEALTHCHECK --interval=30s --start-period=60s --start-interval=2s CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ['PORT'] + '/', timeout=5)"]
# On SIGTERM the server stops a running import and shuts down
STOPSIGNAL SIGTERM
CMD ["dtaluchs", "serve"]

# Labels; ./dtaluchs image sets VERSION, the build on GitHub also SOURCE
ARG VERSION=""
ARG SOURCE=""
ARG LICENSE="Apache-2.0"
LABEL org.opencontainers.image.title="dtaluchs" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.source="$SOURCE" \
      org.opencontainers.image.licenses="$LICENSE"
