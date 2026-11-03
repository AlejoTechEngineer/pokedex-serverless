// Enrutamiento con el patrón Chain of Responsibility (Unidad 4, sección 2).
//
// Cada manejador tiene UNA responsabilidad: reconocer su ruta y atenderla, o delegar al
// siguiente eslabón. Agregar un endpoint = agregar una clase y enlazarla (abierto/cerrado).
//
//   MethodGuard → Health → PokemonById → PokemonList → Stats → (fin: 404)

import { InvalidCursor } from "./repository.js";

export const VALID_TYPES = new Set([
  "Bug", "Dark", "Dragon", "Electric", "Fairy", "Fighting", "Fire", "Flying", "Ghost",
  "Grass", "Ground", "Ice", "Normal", "Poison", "Psychic", "Rock", "Steel", "Water",
]);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function jsonResponse(status, body = null, cacheSeconds = 0) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Convierte un Request de Workers en {method, path, query}; quita el prefijo /api. */
export function parseRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  return { method: request.method.toUpperCase(), path, query: url.searchParams };
}

function intParam(raw, name, min, max = null) {
  if (raw === null || raw === "") return null;
  if (!/^\d{1,9}$/.test(raw)) throw new ApiError(400, `'${name}' debe ser un entero positivo.`);
  const value = Number(raw);
  if (value < min || (max !== null && value > max)) {
    throw new ApiError(400, `'${name}' debe estar ${max !== null ? `entre ${min} y ${max}` : `≥ ${min}`}.`);
  }
  return value;
}

// ------------------------------------------------------------------ eslabón base
class Handler {
  #next = null;
  setNext(handler) {
    this.#next = handler;
    return handler; // permite encadenar: a.setNext(b).setNext(c)
  }
  async handle(req) {
    if (this.matches(req)) return this.process(req);
    if (this.#next) return this.#next.handle(req);
    throw new ApiError(404, `Ruta no encontrada: ${req.method} ${req.path}`);
  }
  matches() { throw new Error("not implemented"); }
  process() { throw new Error("not implemented"); }
}

// ------------------------------------------------------------------- manejadores
export class MethodGuardHandler extends Handler {
  matches(req) { return req.method !== "GET"; }
  process(req) {
    if (req.method === "OPTIONS") return jsonResponse(204);
    throw new ApiError(405, "Método no permitido. Esta API es de solo lectura (GET).");
  }
}

export class HealthHandler extends Handler {
  matches(req) { return req.path === "/health"; }
  process() { return jsonResponse(200, { status: "ok" }); }
}

export class PokemonByIdHandler extends Handler {
  static ROUTE = /^\/pokemon\/([^/]+)$/;
  constructor(repo) { super(); this.repo = repo; }
  matches(req) { return PokemonByIdHandler.ROUTE.test(req.path); }
  async process(req) {
    const id = intParam(PokemonByIdHandler.ROUTE.exec(req.path)[1], "id", 1);
    const forms = await this.repo.getForms(id);
    if (!forms.length) throw new ApiError(404, `No existe un registro con id ${id}.`);
    return jsonResponse(200, { id, forms }, 300);
  }
}

export class PokemonListHandler extends Handler {
  constructor(repo) { super(); this.repo = repo; }
  matches(req) { return req.path === "/pokemon"; }
  async process(req) {
    const q = req.query;
    let type = null;
    if (q.has("type") && q.get("type") !== "") {
      const t = q.get("type").trim();
      type = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
      if (!VALID_TYPES.has(type)) {
        throw new ApiError(400, `Tipo inválido. Opciones: ${[...VALID_TYPES].sort().join(", ")}.`);
      }
    }
    const generation = intParam(q.get("generation"), "generation", 1, 99);
    const limit = intParam(q.get("limit"), "limit", 1, MAX_LIMIT) ?? DEFAULT_LIMIT;
    const name = (q.get("name") ?? "").trim().slice(0, 40) || null;
    try {
      const page = await this.repo.listPage({ type, generation, name, limit, cursor: q.get("cursor") || null });
      return jsonResponse(200, { count: page.items.length, ...page }, 60);
    } catch (err) {
      if (err instanceof InvalidCursor) throw new ApiError(400, err.message);
      throw err;
    }
  }
}

export class StatsHandler extends Handler {
  constructor(repo) { super(); this.repo = repo; }
  matches(req) { return req.path === "/stats"; }
  async process() { return jsonResponse(200, await this.repo.stats(), 60); }
}

export function buildChain(repo) {
  const head = new MethodGuardHandler();
  head
    .setNext(new HealthHandler())
    .setNext(new PokemonByIdHandler(repo))
    .setNext(new PokemonListHandler(repo))
    .setNext(new StatsHandler(repo));
  return head;
}
