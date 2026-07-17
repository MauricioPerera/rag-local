// GET /api/next -> 200 { id, op, args } | 204
//
// Long-poll: la pestaña deja la request abierta hasta que aparezca trabajo, en
// vez de preguntar cada segundo. No es solo cuota (un timer de 1.5s son 57.600
// requests/día, 58% del plan Free gastados sin hacer nada): este loop avanza por
// eventos de RED, que Chrome no throttlea. Los timers en una pestaña de fondo sí
// se frenan (~1/minuto), lo que mataría la API apenas minimizás la ventana.

import { getPending, clearPending, putState, json } from './_queue.js';
import { checkAuth } from './_auth.js';

const HOLD_MS = 25000;
const CHECK_MS = 1000; // 25 comprobaciones: dentro de las 50 llamadas/request

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function onRequestGet({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  // La pestaña cuelga su estado en una llamada que ya hace igual: /api/status
  // sale gratis.
  const q = new URL(request.url).searchParams;
  await putState({
    ready: q.get('ready') === '1',
    dir: q.get('dir') || '',
    collections: Number(q.get('collections')) || 0,
    at: Date.now(),
  });

  if (q.get('peek') === '1') {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }

  const deadline = Date.now() + HOLD_MS;
  while (Date.now() < deadline) {
    const job = await getPending();
    if (job) {
      await clearPending(); // reclamarlo: dos pestañas no pueden tomar el mismo
      return json(job);
    }
    await sleep(CHECK_MS);
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
