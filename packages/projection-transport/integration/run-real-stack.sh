#!/usr/bin/env bash
set -euo pipefail

MONGO_IMAGE="mongo:8.0.14"
RABBIT_IMAGE="rabbitmq:4.1.4-alpine"
MONGO_CONTAINER="redemeine-transport-mongo-$RANDOM"
RABBIT_CONTAINER="redemeine-transport-rabbit-$RANDOM"
available_port() {
  local port
  while true; do
    port=$((30000 + RANDOM % 20000))
    if ! ss -ltn | rg -q ":${port} "; then
      printf '%s' "$port"
      return
    fi
  done
}

MONGO_PORT="${REDEMEINE_TRANSPORT_MONGO_PORT:-$(available_port)}"
RABBIT_PORT="${REDEMEINE_TRANSPORT_RABBIT_PORT:-$(available_port)}"
GIT_SHA="$(git rev-parse HEAD)"
EVIDENCE_PATH="/tmp/redemeine-zyfy4-evidence-${GIT_SHA}-$RANDOM.json"
OLD_EVIDENCE_PATH="/tmp/redemeine-zyfy4-old-${GIT_SHA}-$RANDOM.json"
ACCEPTED_EVIDENCE_PATH="/tmp/redemeine-zyfy4-accepted-${GIT_SHA}-$RANDOM.json"
RECEIPT_PATH="${REDEMEINE_ZYFY4_RECEIPT_PATH:-/tmp/redemeine-zyfy4-${GIT_SHA}.json}"

cleanup() {
  docker rm -f "$MONGO_CONTAINER" "$RABBIT_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$MONGO_CONTAINER" --network host \
  "$MONGO_IMAGE" mongod --port "$MONGO_PORT" --replSet rs0 --bind_ip_all >/dev/null
docker run --detach --name "$RABBIT_CONTAINER" \
  --publish "127.0.0.1:${RABBIT_PORT}:5672" "$RABBIT_IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if ! docker inspect "$MONGO_CONTAINER" --format '{{.State.Running}}' | rg -q true; then
    docker logs "$MONGO_CONTAINER"
    exit 1
  fi
  docker exec "$MONGO_CONTAINER" mongosh --port "$MONGO_PORT" --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$MONGO_CONTAINER" mongosh --port "$MONGO_PORT" --quiet --eval \
  "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:${MONGO_PORT}'}]})" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$MONGO_CONTAINER" mongosh --port "$MONGO_PORT" --quiet --eval 'if (!db.hello().isWritablePrimary) quit(1)' >/dev/null 2>&1 && break
  sleep 1
done
rabbit_ready=false
for _ in $(seq 1 60); do
  if docker exec "$RABBIT_CONTAINER" rabbitmq-diagnostics -q ping >/dev/null 2>&1 \
    && nc -z 127.0.0.1 "$RABBIT_PORT"; then
    rabbit_ready=true
    break
  fi
  sleep 1
done
if [[ "$rabbit_ready" != true ]]; then
  docker logs "$RABBIT_CONTAINER"
  exit 1
fi

MONGO_DIGEST="$(docker image inspect "$MONGO_IMAGE" --format '{{index .RepoDigests 0}}')"
RABBIT_DIGEST="$(docker image inspect "$RABBIT_IMAGE" --format '{{index .RepoDigests 0}}')"
REDEMEINE_MONGO_URI="mongodb://localhost:${MONGO_PORT}/?replicaSet=rs0" \
REDEMEINE_RABBIT_URI="amqp://localhost:${RABBIT_PORT}" \
REDEMEINE_MONGO_DIGEST="$MONGO_DIGEST" REDEMEINE_RABBIT_DIGEST="$RABBIT_DIGEST" \
REDEMEINE_EVIDENCE_PATH="$OLD_EVIDENCE_PATH" REDEMEINE_GIT_SHA="$GIT_SHA" \
pnpm exec tsx integration/realStack.ts
REDEMEINE_MONGO_URI="mongodb://localhost:${MONGO_PORT}/?replicaSet=rs0" \
REDEMEINE_RABBIT_URI="amqp://localhost:${RABBIT_PORT}" \
REDEMEINE_MONGO_DIGEST="$MONGO_DIGEST" REDEMEINE_RABBIT_DIGEST="$RABBIT_DIGEST" \
REDEMEINE_EVIDENCE_PATH="$ACCEPTED_EVIDENCE_PATH" REDEMEINE_GIT_SHA="$GIT_SHA" \
pnpm exec tsx integration/realAcceptedStack.ts
REDEMEINE_OLD_EVIDENCE_PATH="$OLD_EVIDENCE_PATH" \
REDEMEINE_ACCEPTED_EVIDENCE_PATH="$ACCEPTED_EVIDENCE_PATH" \
REDEMEINE_EVIDENCE_PATH="$EVIDENCE_PATH" REDEMEINE_GIT_SHA="$GIT_SHA" \
pnpm exec tsx integration/combineStackEvidence.ts

docker rm -f "$MONGO_CONTAINER" "$RABBIT_CONTAINER" >/dev/null
trap - EXIT
REDEMEINE_EVIDENCE_PATH="$EVIDENCE_PATH" REDEMEINE_RECEIPT_PATH="$RECEIPT_PATH" \
REDEMEINE_MONGO_CONTAINER="$MONGO_CONTAINER" REDEMEINE_RABBIT_CONTAINER="$RABBIT_CONTAINER" \
pnpm exec tsx integration/finalizeReceipt.ts
