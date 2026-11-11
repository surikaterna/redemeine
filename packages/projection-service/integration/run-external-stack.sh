#!/bin/sh
set -eu
# Approval and exact harness digest are checked before any Docker command in this entrypoint.
exec pnpm exec tsx integration/externalStack.ts
