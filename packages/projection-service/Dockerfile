FROM node:24.20.0-bookworm-slim AS build
WORKDIR /build
RUN npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsup.config.base.ts turbo.json ./
COPY packages/aggregate/ packages/aggregate/
COPY packages/kernel/ packages/kernel/
COPY packages/projection/ packages/projection/
COPY packages/projection-runtime-core/ packages/projection-runtime-core/
COPY packages/projection-runtime-store-mongodb/ packages/projection-runtime-store-mongodb/
COPY packages/projection-router-core/ packages/projection-router-core/
COPY packages/projection-worker-core/ packages/projection-worker-core/
COPY packages/projection-transport/ packages/projection-transport/
COPY packages/projection-service/ packages/projection-service/
COPY docs/architecture/projection-live-inline-runtime.md docs/architecture/projection-live-inline-runtime.md
COPY LICENSE ./LICENSE
RUN pnpm install --frozen-lockfile --filter @redemeine/projection-service... \
    && pnpm --filter @redemeine/projection-service... run build
FROM node:24.20.0-bookworm-slim AS runtime
ARG VCS_REF=""
ARG IMAGE_VERSION="0.1.0"
LABEL org.opencontainers.image.source="https://github.com/surikaterna/redemeine" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${IMAGE_VERSION}"
RUN apt-get update && apt-get install -y --no-install-recommends util-linux tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && groupadd --gid 10001 projection && useradd --uid 10001 --gid 10001 --no-create-home projection \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/redemeine-projection \
    && install -d -o root -g root -m 0755 /app/definitions
WORKDIR /app
COPY --from=build /build/packages/projection-service/dist-worker/main.js /build/packages/projection-service/dist-worker/artifact.json /build/packages/projection-service/dist-worker/build-lock.sha256 ./
COPY --from=build /build/packages/projection-service/dist-worker/licenses/ ./licenses/
COPY --from=build /build/LICENSE ./LICENSE
COPY --from=build /build/packages/projection-service/worker-package.json ./package.json
RUN chmod 0644 /app/main.js /app/artifact.json /app/build-lock.sha256 /app/package.json
USER 10001:10001
ENV PROJECTION_MODE=external PROJECTION_EXECUTION=serve
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "--input-type=module", "-e", "const p=Number(process.env.HEALTH_PORT||9464);if(!Number.isSafeInteger(p)||p<1024||p>65535)process.exit(1);try{const r=await fetch('http://127.0.0.1:'+p+'/ready',{signal:AbortSignal.timeout(3000)});process.exit(r.status===200?0:1)}catch{process.exit(1)}"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "node", "/app/main.js"]
