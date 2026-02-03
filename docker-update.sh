#!/usr/bin/env bash
set -euo pipefail

echo "==> Stopping gateway..."
docker compose down

echo "==> Rebuilding Docker image with latest code..."
docker build -t "${OPENCLAW_IMAGE:-openclaw:local}" -f Dockerfile .

echo "==> Starting gateway with updated image..."
docker compose up -d openclaw-gateway

echo "==> Checking health..."
sleep 3
docker compose ps openclaw-gateway

echo ""
echo "==> Update complete!"
echo "View logs: docker compose logs -f openclaw-gateway"
