#!/usr/bin/env bash
# Elimina el Worker y la base D1 (pide confirmación en cada paso).
set -euo pipefail
cd "$(dirname "$0")/.."
npx wrangler delete --name pokedex-serverless
npx wrangler d1 delete "${DB_NAME:-pokedex}"
echo "✔ Recursos eliminados."
