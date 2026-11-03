#!/bin/bash
# SideX Local Development - Start Everything
# Run from the project root: ./scripts/dev-local.sh

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDS=()

cleanup() {
    echo ""
    echo "Shutting down..."
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    exit 0
}
trap cleanup INT TERM

echo "=== SideX Local Development ==="
echo ""

# 1. Start Go Server
echo "Starting the agent server on :7433..."
cd "$ROOT/sidexai/sidex-server"
[ -f .env ] && export $(grep -v '^#' .env | xargs)
export SIDEX_NO_AUTH=${SIDEX_NO_AUTH:-1}
go run -tags "fts5" cmd/server/main.go &
PIDS+=($!)
sleep 2

echo ""
echo "=== All services running ==="
echo "  Agent server: http://localhost:7433/v1/health"
echo ""
echo "Press Ctrl+C to stop all services."
echo ""

wait
