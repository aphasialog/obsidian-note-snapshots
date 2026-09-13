#!/usr/bin/env bash
# Provisions the JS toolchain for the Obsidian plugin build.
set -euo pipefail

PNPM_VERSION="10.25.0"
PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"

echo "==> node $(node --version), npm $(npm --version)"

mkdir -p "$PNPM_HOME/store"

# corepack ships with Node 22. Shims go in $PNPM_HOME (already on PATH) rather than
# next to the corepack binary, which would need root.
if command -v corepack >/dev/null 2>&1; then
	corepack enable pnpm --install-directory "$PNPM_HOME"
	COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare "pnpm@${PNPM_VERSION}" --activate
else
	npm install -g "pnpm@${PNPM_VERSION}"
fi

export PATH="$PNPM_HOME:$PATH"
echo "==> pnpm $(pnpm --version)"
pnpm config set store-dir "$PNPM_HOME/store"

if [ -f package.json ]; then
	pnpm install --frozen-lockfile || pnpm install
else
	echo "==> no package.json yet; skipping install"
fi

echo "==> dev container ready"
