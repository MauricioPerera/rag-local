// _queue.js — buzón entre quien llama a la API y la pestaña que tiene el engine.
//
// Sobre la Cache API del runtime de Workers: sin bindings, sin D1, sin Durable
// Objects. Es por-colo, que acá es exactamente lo que corresponde: quien llama y
// la pestaña están en la misma máquina, así que caen en el mismo colo.
//
// Un Pages Function es stateless. El POST de quien llama y el poll de la pestaña
// son dos ejecuciones distintas que no comparten memoria: acá se encuentran.
//
// Una sola ranura: hay un solo engine con un solo modelo cargado. El resto
// recibe 429.

const PENDING = 'https://rag-queue.internal/pending';
const RESULT = (id) => `https://rag-queue.internal/result/${id}`;
const STATE = 'https://rag-queue.internal/state';
const TTL = 300; // segundos

const cache = () => caches.default;

const body = (obj) =>
  new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `max-age=${TTL}` },
  });

// ── trabajo pendiente ──────────────────────────────────────────────────────

export async function getPending() {
  const hit = await cache().match(new Request(PENDING));
  return hit ? hit.json() : null;
}

export async function putPending(job) {
  await cache().put(new Request(PENDING), body(job));
}

export async function clearPending() {
  await cache().delete(new Request(PENDING));
}

// ── resultados ─────────────────────────────────────────────────────────────

export async function putResult(id, result) {
  await cache().put(new Request(RESULT(id)), body(result));
}

export async function takeResult(id) {
  const hit = await cache().match(new Request(RESULT(id)));
  if (!hit) return null;
  const data = await hit.json();
  await cache().delete(new Request(RESULT(id)));
  return data;
}

// ── estado del worker ──────────────────────────────────────────────────────
// La pestaña lo reporta en cada long-poll de /api/next: no cuesta requests
// extra, es un efecto de una llamada que ya hace igual.

export async function putState(state) {
  await cache().put(new Request(STATE), body(state));
}

export async function getState() {
  const hit = await cache().match(new Request(STATE));
  return hit ? hit.json() : null;
}

// charset=utf-8 explícito: sin eso PowerShell 5.1 decodifica como ISO-8859-1 y
// los acentos llegan rotos. JSON es UTF-8 por spec, pero decirlo no cuesta nada.
export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
