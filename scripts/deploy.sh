#!/usr/bin/env bash
# Despliega TODO en Cloudflare (gratis, sin tarjeta): crea la base D1, carga el esquema y los
# datos, y publica el Worker con el frontend. Requiere Node 18+ y una cuenta gratuita de Cloudflare.
#
#   ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${DB_NAME:-pokedex}"
command -v node >/dev/null || { echo "✘ Falta Node.js (https://nodejs.org)."; exit 1; }
[ -d node_modules ] || { echo "━━ Instalando wrangler"; npm install; }

echo "━━ 1/5 Sesión en Cloudflare"
if ! npx wrangler whoami >/dev/null 2>&1; then npx wrangler login; fi

echo "━━ 2/5 Base de datos D1 ($DB_NAME)"
if ! npx wrangler d1 info "$DB_NAME" >/dev/null 2>&1; then
  npx wrangler d1 create "$DB_NAME"
else
  echo "· La base '$DB_NAME' ya existe; se reutiliza."
fi
DB_ID="$(npx wrangler d1 list --json | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const db=JSON.parse(s).find(d=>d.name===process.argv[1]);
    if(!db){console.error("No se encontró la base");process.exit(1)}
    console.log(db.uuid||db.id||db.database_id)})' "$DB_NAME")"
sed -i.bak -E "s|^database_id = .*|database_id = \"$DB_ID\"|" wrangler.toml && rm -f wrangler.toml.bak
echo "· database_id = $DB_ID (guardado en wrangler.toml)"

echo "━━ 3/5 Esquema y datos"
python3 scripts/build_seed.py
npx wrangler d1 execute "$DB_NAME" --remote --yes --file db/schema.sql
npx wrangler d1 execute "$DB_NAME" --remote --yes --file db/seed.sql

echo "━━ 4/5 Verificación: filas en la nube vs. filas del CSV"
npx wrangler d1 execute "$DB_NAME" --remote --command "SELECT COUNT(*) AS filas, COUNT(DISTINCT id) AS ids_distintos FROM pokemon"
echo "(esperado: filas = 1215, ids_distintos = 1025)"

echo "━━ 5/5 Publicando el Worker + frontend"
npx wrangler deploy
