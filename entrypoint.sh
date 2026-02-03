#!/bin/bash
set -e

# Fix ownership of mounted volumes if they're owned by root
# This handles Docker Desktop + WSL2 scenarios where volumes are initially root:root
if [ -d "/home/node/.openclaw" ]; then
    chown -R 1000:1000 /home/node/.openclaw
fi

# Ensure required directories exist with proper permissions
mkdir -p /home/node/.openclaw/devices
mkdir -p /home/node/.openclaw/gateway
chmod -R 755 /home/node/.openclaw

# Switch to node user with gosu while preserving all environment variables
# We export the current environment before switching users
export $(cat /proc/self/environ | tr '\0' '\n' | grep -v "^PWD=" | grep -v "^SHLVL=")
exec gosu 1000:1000 "$@"
