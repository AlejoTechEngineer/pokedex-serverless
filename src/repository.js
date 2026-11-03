// Capa de acceso a datos (Cloudflare D1). Sin lógica HTTP: solo consultas SQL.
//
// Estrategia de consulta
//  * por id         -> clave primaria (id, form)
//  * por tipo       -> índice idx_pokemon_type       (type1, id)
//  * por generación -> índice idx_pokemon_generation (generation, id)
//  * por nombre     -> LIKE sobre name_lower (tabla pequeña: ~1.2k filas)
// Paginación por cursor ("keyset"): estable y sin OFFSET, con orden global por (id, form).

export const STAT_FIELDS = ["hp", "attack", "defense", "sp_atk", "sp_def", "speed"];
const COLUMNS =
  "id, form, name, type1, type2, total, hp, attack, defense, sp_atk, sp_def, speed, generation";
const STATS_TTL_MS = 60_000;

export class InvalidCursor extends Error {}

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token) {
  const padded = token.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (token.length % 4)) % 4);
  const bin = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeCursor(row) {
  return toBase64Url(JSON.stringify({ id: row.id, form: row.form }));
}

export function decodeCursor(token) {
  try {
    const c = JSON.parse(fromBase64Url(token));
    if (!Number.isInteger(c.id) || typeof c.form !== "string" || c.form.length > 120) throw new Error();
    return c;
  } catch {
    throw new InvalidCursor("El cursor de paginación no es válido.");
  }
}

// null (p. ej. type2 de un solo tipo) se omite para mantener el JSON compacto.
const publicRow = (row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));
const round1 = (n) => Math.round(n * 10) / 10;

export class PokemonRepository {
  constructor(db) {
    this.db = db;
    this.statsCache = null;
  }

  async getForms(id) {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM pokemon WHERE id = ?
         ORDER BY CASE WHEN form = 'Base' THEN 0 ELSE 1 END, form`,
      )
      .bind(id)
      .all();
    return results.map(publicRow);
  }

  async listPage({ type, generation, name, limit, cursor }) {
    const where = [];
    const params = [];
    if (name) {
      // Se escapan los comodines de LIKE que escriba la persona.
      where.push("name_lower LIKE ? ESCAPE '\\'");
      params.push(`%${name.toLowerCase().replace(/[\\%_]/g, (m) => "\\" + m)}%`);
    }
    if (type) { where.push("type1 = ?"); params.push(type); }
    if (generation != null) { where.push("generation = ?"); params.push(generation); }
    const filter = where.length ? "WHERE " + where.join(" AND ") : "";

    if (name) {
      // Búsqueda por nombre: primeras `limit` coincidencias + total de coincidencias.
      const [page, count] = await this.db.batch([
        this.db.prepare(`SELECT ${COLUMNS} FROM pokemon ${filter} ORDER BY id, form LIMIT ?`).bind(...params, limit),
        this.db.prepare(`SELECT COUNT(*) AS n FROM pokemon ${filter}`).bind(...params),
      ]);
      return { items: page.results.map(publicRow), next_cursor: null, total_matches: count.results[0].n };
    }

    const keyset = [...where];
    const keyParams = [...params];
    if (cursor) {
      const c = decodeCursor(cursor);
      keyset.push("(id > ? OR (id = ? AND form > ?))");
      keyParams.push(c.id, c.id, c.form);
    }
    const sql = `SELECT ${COLUMNS} FROM pokemon ${keyset.length ? "WHERE " + keyset.join(" AND ") : ""}
                 ORDER BY id, form LIMIT ?`;
    // Se pide una fila de más para saber con certeza si existe otra página.
    const { results } = await this.db.prepare(sql).bind(...keyParams, limit + 1).all();
    const hasMore = results.length > limit;
    const rows = hasMore ? results.slice(0, limit) : results;
    return {
      items: rows.map(publicRow),
      next_cursor: hasMore ? encodeCursor(rows[rows.length - 1]) : null,
    };
  }

  async stats() {
    const now = Date.now();
    if (this.statsCache && now - this.statsCache.at < STATS_TTL_MS) return this.statsCache.value;

    const avg = [...STAT_FIELDS, "total"].map((f) => `AVG(${f}) AS avg_${f}`).join(", ");
    const [totals, byType, byGen, top] = await this.db.batch([
      this.db.prepare(`SELECT COUNT(*) AS records, COUNT(DISTINCT id) AS species, ${avg} FROM pokemon`),
      this.db.prepare("SELECT type1 AS type, COUNT(*) AS count FROM pokemon GROUP BY type1 ORDER BY count DESC, type1"),
      this.db.prepare("SELECT generation, COUNT(*) AS count FROM pokemon GROUP BY generation ORDER BY generation"),
      this.db.prepare("SELECT id, name, form, total FROM pokemon ORDER BY total DESC, id, form LIMIT 5"),
    ]);
    const t = totals.results[0];
    const value = {
      total_records: t.records,
      unique_species: t.species,
      by_type: byType.results,
      by_generation: byGen.results,
      average_stats: Object.fromEntries(STAT_FIELDS.map((f) => [f, round1(t[`avg_${f}`])])),
      average_total: round1(t.avg_total),
      top_total: top.results,
    };
    this.statsCache = { at: now, value };
    return value;
  }
}
