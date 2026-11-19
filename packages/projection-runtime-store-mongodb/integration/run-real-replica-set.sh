#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/projection-mongo-version.sh"
CONTAINER="redemeine-projection-v2-$RANDOM"
PORT="${REDEMEINE_MONGO_PORT:-27029}"
GIT_SHA="$(git rev-parse HEAD)"
WORK_DIR="$(mktemp -d)"
EVIDENCE_PATH="$WORK_DIR/evidence.json"
RECEIPT_PATH="${REDEMEINE_ZYFY3_RECEIPT_PATH:-${TMPDIR:-/tmp}/redemeine-zyfy3-${GIT_SHA}-mongo-${MONGO_VERSION}.json}"

cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

docker run --detach --name "$CONTAINER" \
  --network host \
  "$MONGO_IMAGE" mongod --port "$PORT" --replSet rs0 --bind_ip 127.0.0.1 --setParameter enableTestCommands=1 >/dev/null

for _ in $(seq 1 60); do
  if [[ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}')" != true ]]; then
    docker logs "$CONTAINER" >&2
    exit 1
  fi
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

MONGO_DIGEST="$(docker image inspect "$MONGO_IMAGE" --format '{{index .RepoDigests 0}}')"
REDEMEINE_MONGO_URI="mongodb://localhost:${PORT}/?replicaSet=rs0" \
  pnpm exec tsx integration/realReplicaSet.ts > "$EVIDENCE_PATH"
docker rm -fv "$CONTAINER" >/dev/null
REDEMEINE_EVIDENCE_PATH="$EVIDENCE_PATH" REDEMEINE_RECEIPT_PATH="$RECEIPT_PATH" \
REDEMEINE_MONGO_CONTAINER="$CONTAINER" REDEMEINE_MONGO_DIGEST="$MONGO_DIGEST" \
REDEMEINE_EXPECTED_MONGO_VERSION="$MONGO_VERSION" \
  pnpm exec tsx integration/finalizeReplicaSetReceipt.ts
