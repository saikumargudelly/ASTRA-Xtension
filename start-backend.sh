#!/usr/bin/env bash
# ASTRA Backend Server — run this script to keep the backend alive
# Usage: ./start-backend.sh
cd "$(dirname "$0")"
echo "[ASTRA] Starting backend server on port 3001..."
exec npm run dev:backend
