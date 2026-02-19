#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

chmod +x .githooks/pre-commit
git config core.hooksPath .githooks

echo "Configured git hooks path: .githooks"
