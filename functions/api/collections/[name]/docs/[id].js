// PUT    /api/collections/:name/docs/:id  { md }  -> editar (reemplaza ese doc)
// DELETE /api/collections/:name/docs/:id          -> borrar ese doc
//
// CRUD por documento sobre una colección existente. La pestaña carga el índice,
// aplica el cambio y reescribe el .jvsb. Editar exige que el id exista (para
// agregar uno nuevo: POST …/docs). Borrar rechaza el último doc de la colección.

import { checkAuth } from '../../../_auth.js';
import { rpc } from '../../../_rpc.js';
import { json } from '../../../_queue.js';

export async function onRequestPut({ request, env, params }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'el body debe ser JSON' }, 400);
  }
  const md = typeof body?.md === 'string' ? body.md : '';
  if (!md) return json({ error: "falta 'md' (el documento OKF)" }, 400);

  return rpc('updateDocument', { name: params.name, id: params.id, md });
}

export async function onRequestDelete({ request, env, params }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  return rpc('removeDocument', { name: params.name, id: params.id });
}
