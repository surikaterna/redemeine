#!/usr/bin/env bash
set -euo pipefail

mongo="redemeine-zz6h-mongo-$RANDOM"
rabbit="redemeine-zz6h-rabbit-$RANDOM"
available_port() {
  local port
  while true; do
    port=$((30000 + RANDOM % 20000))
    if ! ss -ltn | rg -q ":${port} "; then printf '%s' "$port"; return; fi
  done
}
mongo_port="$(available_port)"
rabbit_port="$(available_port)"
sha="$(git rev-parse HEAD)"
receipt="${REDEMEINE_ZZ6H_RECEIPT_PATH:-/tmp/opencode/zz6h-joined-${sha}.json}"
cleanup() { docker rm -f "$mongo" "$rabbit" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$mongo" --network host mongo:8.0.14 \
  mongod --port "$mongo_port" --replSet rs0 --bind_ip_all >/dev/null
docker run -d --name "$rabbit" -p "127.0.0.1:${rabbit_port}:5672" rabbitmq:4.1.4-alpine >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker inspect "$mongo" --format '{{.State.Running}}')" != true ]]; then
    docker logs "$mongo"
    exit 1
  fi
  docker exec "$mongo" mongosh --port "$mongo_port" --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$mongo" mongosh --port "$mongo_port" --quiet --eval \
  "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:${mongo_port}'}]})" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$mongo" mongosh --port "$mongo_port" --quiet --eval 'if (!db.hello().isWritablePrimary) quit(1)' >/dev/null 2>&1 \
    && docker exec "$rabbit" rabbitmq-diagnostics -q ping >/dev/null 2>&1 \
    && nc -z 127.0.0.1 "$rabbit_port" && break
  sleep 1
done
REDEMEINE_MONGO_URI="mongodb://localhost:${mongo_port}/?replicaSet=rs0" \
REDEMEINE_RABBIT_URI="amqp://localhost:${rabbit_port}" \
  pnpm exec tsx integration/realJoinedCutover.ts | tee "$receipt"
cleanup
trap - EXIT
printf 'Focused receipt: %s\n' "$receipt"
sha256sum "$receipt"
