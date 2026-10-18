#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd -- "$root"
# SAFETY: dist is this package's generated output, never source or parent-workspace data.
rm -rf -- dist
pnpm exec tsc -p tsconfig.build.json
chmod +x dist/email-cli-main.js
