#!/bin/bash
# Debug script for SFPM CLI - can be run from any directory
# Usage: /path/to/sfpm/packages/cli/bin/debug.sh install my-package -o my-org

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEBUG=* node --inspect-brk --loader ts-node/esm --disable-warning=ExperimentalWarning "$SCRIPT_DIR/dev.js" "$@"
