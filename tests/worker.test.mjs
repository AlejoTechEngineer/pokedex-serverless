import test from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./d1-shim.mjs";
import { handleRequest } from "../src/worker.js";
import { decodeCursor, encodeCursor } from "../src/repository.js";

const ROOT = new URL("../", import.meta.url);
const env = { DB: createD1(ROOT) };

async function api(path, init = {}) {
  const res = await handleRequest(new Request("https://pokedex.test/api" + path, init), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

test("la base cargada tiene 1215 filas y 1025 ids distintos", () => {
  const r = env.DB.raw.prepare("SELECT COUNT(*) n, COUNT(DISTINCT id) d FROM pokemon").get();
  assert.equal(r.n, 1215);
  assert.equal(r.d, 1025);
});

test("health", async () => {
  const r = await api("/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: "ok" });
});

test("buscar por ID devuelve todas las formas, con Base primero", async () => {
  const r = await api("/pokemon/25");
  assert.equal(r.status, 200);
  assert.equal(r.body.forms[0].name, "Pikachu");
  assert.equal(r.body.forms[0].form, "Base");
  assert.ok(r.body.forms.length >= 2);
  assert.ok(!("name_lower" in r.body.forms[0]));
  const raichu = await api("/pokemon/26");
  assert.equal(raichu.body.forms[0].form, "Base"); // aunque exista "Alolan Raichu"
  assert.ok((await api("/pokemon/6")).body.forms.length >= 3);
});

test("type2 nulo se omite del JSON", async () => {
  const r = await api("/pokemon/4");
  assert.equal(r.body.forms[0].type1, "Fire");
  assert.ok(!("type2" in r.body.forms[0]));
});

test("ID inexistente o inválido", async () => {
  assert.equal((await api("/pokemon/99999")).status, 404);
  assert.equal((await api("/pokemon/abc")).status, 400);
  assert.equal((await api("/pokemon/0")).status, 400);
});

test("filtro por tipo, ordenado por id", async () => {
  const r = await api("/pokemon?type=fire&limit=100");
  assert.equal(r.status, 200);
  const ids = r.body.items.map((i) => i.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.ok(r.body.items.every((i) => i.type1 === "Fire"));
});

test("filtro por generación y combinado", async () => {
  const g = await api("/pokemon?generation=1&limit=100");
  assert.ok(g.body.items.every((i) => i.generation === 1));
  assert.equal(g.body.items[0].id, 1);
  const c = await api("/pokemon?type=Water&generation=1&limit=100");
  assert.ok(c.body.items.length > 0 && c.body.items.every((i) => i.type1 === "Water" && i.generation === 1));
});

test("la paginación recorre todo sin duplicados y en orden", async () => {
  const seen = [];
  let cursor = null, pages = 0;
  do {
    const r = await api(`/pokemon?type=Water&limit=7${cursor ? "&cursor=" + cursor : ""}`);
    seen.push(...r.body.items.map((i) => `${i.id}|${i.form}`));
    cursor = r.body.next_cursor;
    pages++;
    if (cursor) assert.equal(r.body.count, 7);
  } while (cursor);
  const expected = env.DB.raw.prepare("SELECT COUNT(*) n FROM pokemon WHERE type1='Water'").get().n;
  assert.equal(seen.length, expected);
  assert.equal(new Set(seen).size, expected);
  assert.ok(pages > 1);
  const ids = seen.map((k) => Number(k.split("|")[0]));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

test("sin filtros también se pagina y queda ordenado por id", async () => {
  const r = await api("/pokemon?limit=5");
  assert.equal(r.body.count, 5);
  const ids = r.body.items.map((i) => i.id);
  assert.equal(ids[0], 1);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b)); // Venusaur repite id por sus formas
  assert.ok(r.body.next_cursor);
});

test("búsqueda por nombre parcial, sin distinguir mayúsculas", async () => {
  const r = await api("/pokemon?name=PIKA");
  assert.ok(r.body.items.some((i) => i.name === "Pikachu"));
  assert.equal(r.body.total_matches, r.body.items.length);
  assert.equal(r.body.next_cursor, null);
});

test("los comodines de LIKE escritos por la persona no se interpretan", async () => {
  // "%" solo coincide con nombres que lo contienen de forma literal (los dos Zygarde),
  // no con todos: el comodín de LIKE queda escapado.
  const r = await api("/pokemon?name=%25");
  assert.equal(r.body.total_matches, 2);
  assert.ok(r.body.items.every((i) => i.name.includes("%")));
  const u = await api("/pokemon?name=_");
  assert.equal(u.body.total_matches, 0);
});

test("la búsqueda por nombre respeta el límite e informa el total", async () => {
  const r = await api("/pokemon?name=a&limit=5");
  assert.equal(r.body.items.length, 5);
  assert.ok(r.body.total_matches > 5);
});

test("validaciones 400", async () => {
  assert.equal((await api("/pokemon?type=Cosmico")).status, 400);
  assert.equal((await api("/pokemon?limit=1000")).status, 400);
  assert.equal((await api("/pokemon?generation=x")).status, 400);
  assert.equal((await api("/pokemon?cursor=basura")).status, 400);
});

test("estadísticas", async () => {
  const { body: s } = await api("/stats");
  assert.equal(s.total_records, 1215);
  assert.equal(s.unique_species, 1025);
  assert.equal(s.by_type.reduce((a, t) => a + t.count, 0), 1215);
  assert.equal(s.by_generation.reduce((a, g) => a + g.count, 0), 1215);
  assert.deepEqual(Object.keys(s.average_stats).sort(), ["attack", "defense", "hp", "sp_atk", "sp_def", "speed"]);
  assert.equal(s.top_total.length, 5);
  assert.ok(s.top_total[0].total >= s.top_total[1].total);
});

test("método, ruta, CORS y caché", async () => {
  assert.equal((await api("/pokemon", { method: "POST" })).status, 405);
  assert.equal((await api("/pokemon", { method: "OPTIONS" })).status, 204);
  assert.equal((await api("/nada")).status, 404);
  const r = await api("/stats");
  assert.match(r.headers.get("cache-control"), /max-age=60/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("cursor: ida y vuelta con caracteres no ASCII", () => {
  const row = { id: 669, form: "Flabébé Rojo ñ" };
  assert.deepEqual(decodeCursor(encodeCursor(row)), row);
});

test("el esquema de db/schema.sql declara la clave (id, form) y 2 índices", () => {
  const idx = env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all();
  assert.deepEqual(idx.map((i) => i.name).sort(), ["idx_pokemon_generation", "idx_pokemon_type"]);
});
