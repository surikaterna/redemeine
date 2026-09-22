#!/usr/bin/env bash
set -euo pipefail

MONGO_IMAGE="mongo:8.0.14"
MONGO_CONTAINER="redemeine-migration-mongo-$RANDOM"
MONGO_PORT="${REDEMEINE_MIGRATION_MONGO_PORT:-$((30000 + RANDOM % 20000))}"
GIT_SHA="$(git rev-parse HEAD)"
EVIDENCE_PATH="/tmp/redemeine-zyfy5-evidence-${GIT_SHA}-$RANDOM.json"
RECEIPT_PATH="${REDEMEINE_ZYFY5_RECEIPT_PATH:-/tmp/redemeine-zyfy5-${GIT_SHA}.json}"
RUNTIME_ARTIFACT="/tmp/redemeine-migration-runtime-${GIT_SHA}.mjs"

cleanup() { docker rm -f "$MONGO_CONTAINER" >/dev/null 2>&1 || true; rm -f "$RUNTIME_ARTIFACT"; }
trap cleanup EXIT
pnpm exec esbuild integration/migrationRuntime.ts --bundle --platform=node --format=esm --target=node24 --outfile="$RUNTIME_ARTIFACT" >/dev/null
chmod 0444 "$RUNTIME_ARTIFACT"
RUNTIME_ARTIFACT_DIGEST="sha256:$(sha256sum "$RUNTIME_ARTIFACT" | cut -d' ' -f1)"
docker run --detach --name "$MONGO_CONTAINER" --network host \
  "$MONGO_IMAGE" mongod --port "$MONGO_PORT" --replSet rs0 --bind_ip_all --setParameter enableTestCommands=1 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$MONGO_CONTAINER" mongosh --port "$MONGO_PORT" --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$MONGO_CONTAINER" mongosh --port "$MONGO_PORT" --quiet --eval \
  "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:${MONGO_PORT}'}]})" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$MONGO_CONTAINER" mongosh --port "$MONGO_PORT" --quiet --eval 'if (!db.hello().isWritablePrimary) quit(1)' >/dev/null 2>&1 && break
  sleep 1
done
MONGO_DIGEST="$(docker image inspect "$MONGO_IMAGE" --format '{{index .RepoDigests 0}}')"
REDEMEINE_MONGO_URI="mongodb://localhost:${MONGO_PORT}/?replicaSet=rs0" \
  REDEMEINE_EVIDENCE_PATH="$EVIDENCE_PATH" REDEMEINE_GIT_SHA="$GIT_SHA" REDEMEINE_RUNTIME_ARTIFACT="$RUNTIME_ARTIFACT" \
  REDEMEINE_RUNTIME_ARTIFACT_DIGEST="$RUNTIME_ARTIFACT_DIGEST" pnpm exec tsx integration/realMigration.ts
rm -f "$RUNTIME_ARTIFACT"
docker rm -f "$MONGO_CONTAINER" >/dev/null
trap - EXIT
REDEMEINE_EVIDENCE_PATH="$EVIDENCE_PATH" REDEMEINE_RECEIPT_PATH="$RECEIPT_PATH" \
  REDEMEINE_MONGO_CONTAINER="$MONGO_CONTAINER" REDEMEINE_MONGO_DIGEST="$MONGO_DIGEST" \
  REDEMEINE_RUNTIME_ARTIFACT="$RUNTIME_ARTIFACT" pnpm exec tsx integration/finalizeMigrationReceipt.ts
