// Simulador mínimo de D1 sobre SQLite real (node:sqlite), solo para pruebas unitarias.
// Implementa la parte de la API de D1 que usa el repositorio: prepare().bind().all()/first() y batch().
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), success: true }; }
  async first() { const r = this.db.prepare(this.sql).get(...this.params); return r ? { ...r } : null; }
}

export function createD1(root) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("db/schema.sql", root), "utf8"));
  db.exec(readFileSync(new URL("db/seed.sql", root), "utf8"));
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    batch: (stmts) => Promise.all(stmts.map((s) => s.all())),
  };
}
