#!/usr/bin/env bash
set -euo pipefail

MONGO_IMAGE="mongo:8.0.14"
MONGO_CONTAINER="redemeine-migration-mongo-$RANDOM"
MONGO_PORT="${REDEMEINE_MIGRATION_MONGO_PORT:-$((30000 + RANDOM % 20000))}"

cleanup() { docker rm -f "$MONGO_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --name "$MONGO_CONTAINER" --network host \
  "$MONGO_IMAGE" mongod --port "$MONGO_PORT" --replSet rs0 --bind_ip_all >/dev/null
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
REDEMEINE_MONGO_URI="mongodb://localhost:${MONGO_PORT}/?replicaSet=rs0" pnpm exec tsx integration/realMigration.ts
