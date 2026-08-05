# Reproducible CI environment for sfpm actions/workflows:
# Node + pnpm + turbo + sf CLI + sfpm CLI, so workflow jobs can skip
# `pnpm/action-setup`, `actions/setup-node`, and manual CLI installs.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

RUN pnpm add -g turbo @salesforce/cli @b64hub/sfpm-cli

WORKDIR /workspace
