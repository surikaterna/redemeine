ARG NODE_IMAGE=node:24.20.0-bookworm-slim
FROM ${NODE_IMAGE}
ARG SOURCE_MANIFEST
ARG ARTIFACT_DIGEST
LABEL org.redemeine.qualification.source=$SOURCE_MANIFEST
LABEL org.redemeine.qualification.artifact=$ARTIFACT_DIGEST
RUN apt-get update && apt-get install -y --no-install-recommends util-linux tini socat \
    && rm -rf /var/lib/apt/lists/* \
    && /usr/bin/flock --version && test "$(node --version)" = v24.20.0 \
    && groupadd --gid 10001 projection && useradd --uid 10001 --gid 10001 --no-create-home projection \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/redemeine-projection
WORKDIR /app
COPY main.js artifact.json build-lock.sha256 ./
COPY qualification-entry.sh /usr/local/bin/qualification-entry.sh
RUN chmod 0755 /usr/local/bin/qualification-entry.sh
USER 10001:10001
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/qualification-entry.sh"]
