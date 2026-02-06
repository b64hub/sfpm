#!/bin/bash
# Debug script for SFPM CLI - can be run from any directory
# Usage: /path/to/sfpm/packages/cli/bin/debug.sh install my-package -o my-org

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SFPM_ROOT="$(dirname "$(dirname "$(dirname "$SCRIPT_DIR")")")"

# Capture user's project directory BEFORE changing to sfpm root
USER_PROJECT_DIR="$(pwd -P)"

# Run from SFPM root where ts-node is installed
# Pass user's directory via env var - CLI will use SFPM_PROJECT_DIR instead of process.cwd()
cd "$SFPM_ROOT"
SFPM_PROJECT_DIR="$USER_PROJECT_DIR" DEBUG=* node --inspect-brk --loader ts-node/esm --disable-warning=ExperimentalWarning "$SCRIPT_DIR/dev.js" "$@"
