// GET  /api/collections          -> string[]                 (engine.listCollections)
// POST /api/collections {name,docs} -> resultado de createCollection
//
// Espejo exacto de rag-server.mjs: mismo path, mismo body, misma respuesta. Esa
// es la idea — el mismo rag-cli.mjs puede apuntar a este o al servidor Node.

import { checkAuth } from '../_auth.js';
import { rpc } from '../_rpc.js';
import { json } from '../_queue.js';

export async function onRequestGet({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;
  return rpc('listCollections', {});
}

export async function onRequestPost({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'el body debe ser JSON' }, 400);
  }
  if (!body?.name) return json({ error: "falta 'name'" }, 400);
  if (!Array.isArray(body?.docs)) return json({ error: "falta 'docs' (array de { id, md })" }, 400);

  // Indexar embebe un vector por chunk: con muchos docs esto tarda, y el tope
  // real es el presupuesto de _rpc (~6 min), no la paciencia.
  return rpc('createCollection', { name: body.name, docs: body.docs });
}
