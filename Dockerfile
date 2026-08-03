# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY frontend/ ./
RUN npm run build

FROM rust:1.95.0-bookworm AS backend-builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY backend/Cargo.toml backend/Cargo.toml
COPY backend/src backend/src

RUN --mount=type=cache,id=lume-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=lume-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=lume-cargo-target,target=/app/target \
    cargo build --locked --release -p lume-server \
    && cp /app/target/release/lume-server /lume-server

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 lume \
    && useradd --uid 10001 --gid lume --home-dir /app --no-create-home --shell /usr/sbin/nologin lume

WORKDIR /app

COPY --from=backend-builder --chown=lume:lume /lume-server /usr/local/bin/lume-server
COPY --from=frontend-builder --chown=lume:lume /app/frontend/dist /app/frontend/dist

RUN chmod --recursive a+rX /app/frontend/dist \
    && mkdir --parents /app/data \
    && chown lume:lume /app/data

ENV LUME_ADDRESS=0.0.0.0:8080 \
    LUME_DATABASE_URL=sqlite:///app/data/lume.db \
    LUME_FRONTEND_DIST=/app/frontend/dist \
    LUME_SECRET_KEY_FILE=/app/data/lume.key

USER lume

EXPOSE 8080

ENTRYPOINT ["lume-server"]
