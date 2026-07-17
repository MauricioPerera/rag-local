// DELETE /api/collections/:name — espejo de rag-server.mjs.
import { checkAuth } from '../_auth.js';
import { rpc } from '../_rpc.js';

export async function onRequestDelete({ request, env, params }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;
  return rpc('deleteCollection', { name: params.name });
}
