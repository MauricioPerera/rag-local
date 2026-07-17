// Bytes crudos entre la pestaña y quien llama, sin pasar por JSON.
//
//   POST /api/blob?id=X   la pestaña sube el bundle exportado
//   GET  /api/blob?id=X   la pestaña baja el bundle a importar
//
// Streaming en los dos sentidos: request.body es un ReadableStream y se lo
// pasamos a la cache tal cual. Nada de base64 ni de materializar MB en memoria.

import { putBlob, takeBlob, json } from './_queue.js';
import { checkAuth } from './_auth.js';

export async function onRequestPost({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ error: "falta 'id'" }, 400);

  await putBlob(id, request.body);
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ error: "falta 'id'" }, 400);

  // keep: la pestaña puede reintentar la lectura si algo se corta a mitad.
  const hit = await takeBlob(id, { keep: true });
  if (!hit) return json({ error: 'blob inexistente o vencido' }, 404);
  return new Response(hit.body, {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
  });
}
