// POST /api/result { id, value } | { id, error, status }
// La pestaña devuelve acá lo que dio el engine; el endpoint que corresponda está
// esperando. Autenticado: si no, cualquiera podría inyectar resultados falsos.

import { putResult, json } from './_queue.js';
import { checkAuth } from './_auth.js';

export async function onRequestPost({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'el body debe ser JSON' }, 400);
  }
  if (!payload?.id) return json({ error: "falta 'id'" }, 400);

  await putResult(payload.id, {
    value: payload.value ?? null,
    error: payload.error ?? null,
    status: payload.status ?? null,
  });
  return json({ ok: true });
}
