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
evidence="$(mktemp /tmp/opencode/zz6h-focused-evidence.XXXXXX.json)"
cleanup() {
  docker rm -f "$mongo" "$rabbit" >/dev/null 2>&1 || true
  rm -f "$evidence"
}
trap cleanup EXIT

docker run -d --name "$mongo" --network host mongo:8.0.14 \
  bash -c "openssl rand -base64 756 > /tmp/zz6h-keyfile && chmod 400 /tmp/zz6h-keyfile && exec mongod --port ${mongo_port} --replSet rs0 --bind_ip_all --auth --keyFile /tmp/zz6h-keyfile" >/dev/null
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
root_password="$(openssl rand -hex 24)"
for _ in $(seq 1 60); do
  if docker exec "$mongo" mongosh --port "$mongo_port" --quiet --eval 'if (!db.hello().isWritablePrimary) quit(1)' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$mongo" mongosh --port "$mongo_port" --quiet --eval \
  "db.getSiblingDB('admin').createUser({user:'zz6h-root',pwd:'${root_password}',roles:[{role:'root',db:'admin'}]})" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$mongo" mongosh --port "$mongo_port" --quiet --eval 'if (!db.hello().isWritablePrimary) quit(1)' >/dev/null 2>&1 \
    && docker exec "$rabbit" rabbitmq-diagnostics -q ping >/dev/null 2>&1 \
    && nc -z 127.0.0.1 "$rabbit_port" && break
  sleep 1
done
REDEMEINE_MONGO_URI="mongodb://zz6h-root:${root_password}@localhost:${mongo_port}/?authSource=admin&replicaSet=rs0" \
REDEMEINE_RABBIT_URI="amqp://localhost:${rabbit_port}" \
REDEMEINE_GIT_SHA="$sha" \
REDEMEINE_MONGO_DIGEST="$(docker image inspect mongo:8.0.14 --format '{{index .RepoDigests 0}}')" \
REDEMEINE_RABBIT_DIGEST="$(docker image inspect rabbitmq:4.1.4-alpine --format '{{index .RepoDigests 0}}')" \
  pnpm exec tsx integration/realJoinedCutover.ts | tee "$evidence"
docker rm -f "$mongo" "$rabbit" >/dev/null
if docker inspect "$mongo" >/dev/null 2>&1 || docker inspect "$rabbit" >/dev/null 2>&1; then
  printf 'Focused containers were not removed\n' >&2
  exit 1
fi
node -e 'const fs=require("fs");const evidence=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(evidence.gitSha!==process.argv[3]||evidence.mongoUsersAndDatabaseCleaned!==true||evidence.queuesAndExchangesDeleted!==true||!Array.isArray(evidence.cases)||evidence.cases.length<20)throw Error("Incomplete focused evidence");fs.writeFileSync(process.argv[2],JSON.stringify({...evidence,containersRemoved:true}),{flag:"wx"});' "$evidence" "$receipt" "$sha"
rm -f "$evidence"
trap - EXIT
printf 'Focused receipt: %s\n' "$receipt"
sha256sum "$receipt"
