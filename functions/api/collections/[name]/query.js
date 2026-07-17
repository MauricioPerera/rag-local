// POST /api/collections/:name/query { text, k } -> hits[]
//
// El endpoint que importa: la consulta viaja hasta la pestaña, que embebe el
// texto y busca en el índice; los vectores nunca salen de tu máquina. Lo que sí
// pasa por Cloudflare es la consulta y los chunks que vuelven — el trato es ese.

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
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ error: "falta 'text'" }, 400);

  return rpc('query', { name: params.name, text, k: body.k });
}
