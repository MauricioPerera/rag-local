// POST /api/collections/:name/docs { docs } -> agrega docs a una colección EXISTENTE
//
// Append incremental: mismas reglas OKF que crear, pero sobre una colección que
// ya existe. La pestaña carga el índice, embebe los nuevos y reescribe el .jvsb
// (el bundle se reescribe entero — no es un append byte-a-byte en disco). Rechaza
// ids que ya viven en la colección: agrega, no pisa.

import { checkAuth } from '../../_auth.js';
import { rpc } from '../../_rpc.js';
import { json } from '../../_queue.js';

export async function onRequestPost({ request, env, params }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'el body debe ser JSON' }, 400);
  }
  if (!Array.isArray(body?.docs)) {
    return json({ error: "falta 'docs' (array de { id, md })" }, 400);
  }

  return rpc('addDocuments', { name: params.name, docs: body.docs });
}
