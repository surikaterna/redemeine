#!/usr/bin/env bash
set -euo pipefail

IMAGE="mongo:8.0.14"
CONTAINER="redemeine-projection-v2-$RANDOM"
PORT="${REDEMEINE_MONGO_PORT:-27029}"
GIT_SHA="$(git rev-parse HEAD)"
EVIDENCE_PATH="/tmp/redemeine-zyfy3-evidence-${GIT_SHA}-$RANDOM.json"
RECEIPT_PATH="${REDEMEINE_ZYFY3_RECEIPT_PATH:-/tmp/redemeine-zyfy3-${GIT_SHA}.json}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --rm --name "$CONTAINER" \
  --network host \
  "$IMAGE" mongod --port "$PORT" --replSet rs0 --bind_ip_all --setParameter enableTestCommands=1 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" mongosh --port "$PORT" --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$CONTAINER" mongosh --port "$PORT" --quiet --eval \
  "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:${PORT}'}]})" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" mongosh --port "$PORT" --quiet --eval 'if (!db.hello().isWritablePrimary) quit(1)' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

MONGO_DIGEST="$(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}')"
REDEMEINE_MONGO_URI="mongodb://localhost:${PORT}/?replicaSet=rs0" \
  pnpm exec tsx integration/realReplicaSet.ts > "$EVIDENCE_PATH"
docker rm -f "$CONTAINER" >/dev/null
trap - EXIT
REDEMEINE_EVIDENCE_PATH="$EVIDENCE_PATH" REDEMEINE_RECEIPT_PATH="$RECEIPT_PATH" \
  REDEMEINE_MONGO_CONTAINER="$CONTAINER" REDEMEINE_MONGO_DIGEST="$MONGO_DIGEST" \
  pnpm exec tsx integration/finalizeReplicaSetReceipt.ts
