FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
ENV HOME=/qualification-home XDG_CONFIG_HOME=/qualification-home/config XDG_CACHE_HOME=/qualification-home/cache
ENV TURBO_REMOTE_CACHE=0 TURBO_CACHE=local:rw TURBO_TELEMETRY_DISABLED=1 TURBO_CONCURRENCY=1
WORKDIR /work
CMD ["sleep", "infinity"]
