// GET /api/collections/:name/export -> el .jvsb crudo
// Espejo de rag-server.mjs, que responde el bundle como octet-stream.
//
// La pestaña sube los bytes a /api/blob y avisa por /api/result que ya están.
// Se sondea SOLO el result (JSON chico, 1 llamada a cache por vuelta): traer el
// blob es una sola llamada al final. Sondear los dos partiría el presupuesto de
// 45 llamadas a la mitad.

import { checkAuth } from '../../_auth.js';
import { getPending, putPending, clearPending, takeResult, takeBlob, json } from '../../_queue.js';

const MAX_CACHE_CALLS = 43;
const CLAIM_TIMEOUT_MS = 15000;
const FIRST_DELAY_MS = 250;
const BACKOFF = 1.35;
const MAX_DELAY_MS = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function onRequestGet({ request, env, params }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  let calls = 0;
  calls++;
  if (await getPending()) return json({ error: 'busy — hay otra operación en curso' }, 429);

  const id = crypto.randomUUID();
  calls++;
  await putPending({ id, op: 'exportBundle', args: { name: params.name }, blobId: id });

  const startedAt = Date.now();
  let delay = FIRST_DELAY_MS;
  let claimChecked = false;

  while (calls < MAX_CACHE_CALLS) {
    await sleep(delay);
    delay = Math.min(MAX_DELAY_MS, delay * BACKOFF);

    calls++;
    const result = await takeResult(id);
    if (result) {
      if (result.error) return json({ error: result.error }, result.status ?? 400);
      calls++;
      const blob = await takeBlob(id);
      if (!blob) return json({ error: 'la pestaña dijo que subió el bundle pero no está' }, 500);
      return new Response(blob.body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${params.name}.jvsb"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    if (!claimChecked && Date.now() - startedAt > CLAIM_TIMEOUT_MS) {
      claimChecked = true;
      calls++;
      const still = await getPending();
      if (still && still.id === id) {
        calls++;
        await clearPending();
        return json({ error: 'no hay worker — abrí rag-web, elegí la carpeta y cargá el modelo' }, 503);
      }
    }
  }
  return json({ error: 'timeout esperando a la pestaña', ms: Date.now() - startedAt }, 504);
}
