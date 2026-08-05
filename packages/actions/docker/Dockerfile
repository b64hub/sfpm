# Reproducible environment for running sfpm actions: Node + sf CLI + sfpm CLI.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @salesforce/cli @b64hub/sfpm-cli

WORKDIR /workspace
