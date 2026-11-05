// Punto de entrada del Worker.
//
// La cadena de manejadores se crea una sola vez por "isolate" y se reutiliza en las
// peticiones siguientes (arranque en caliente). Los archivos estáticos del
// frontend los sirve Cloudflare directamente (ver [assets] en wrangler.toml); este Worker
// solo recibe las rutas /api/*.

import { ApiError, buildChain, jsonResponse, parseRequest } from "./chain.js";
import { PokemonRepository } from "./repository.js";

const chains = new WeakMap(); // env.DB -> cadena

function chainFor(env) {
  if (!chains.has(env.DB)) chains.set(env.DB, buildChain(new PokemonRepository(env.DB)));
  return chains.get(env.DB);
}

export async function handleRequest(request, env) {
  const started = Date.now();
  const req = parseRequest(request);
  let response;
  try {
    response = await chainFor(env).handle(req);
  } catch (err) {
    if (err instanceof ApiError) {
      response = jsonResponse(err.status, { error: err.message });
    } else {
      console.error("Error no controlado", err);
      response = jsonResponse(500, { error: "Error interno del servidor." });
    }
  }
  // Log estructurado (JSON): se ve en tiempo real con `wrangler tail`.
  console.log(JSON.stringify({
    method: req.method, path: req.path, query: Object.fromEntries(req.query),
    status: response.status, duration_ms: Date.now() - started,
  }));
  return response;
}

export default {
  fetch: (request, env) => handleRequest(request, env),
};
