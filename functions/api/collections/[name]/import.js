// POST /api/collections/:name/import  (body: el .jvsb crudo)
// Espejo de rag-server.mjs, que recibe el bundle como octet-stream.
//
// Los bytes van directo del request a la cache en streaming; la pestaña los baja
// de /api/blob. En ningún momento pasan por JSON.

import { checkAuth } from '../../_auth.js';
import { getPending, putPending, clearPending, takeResult, putBlob, json } from '../../_queue.js';

const MAX_CACHE_CALLS = 43;
const CLAIM_TIMEOUT_MS = 15000;
const FIRST_DELAY_MS = 250;
const BACKOFF = 1.35;
const MAX_DELAY_MS = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function onRequestPost({ request, env, params }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  let calls = 0;
  calls++;
  if (await getPending()) return json({ error: 'busy — hay otra operación en curso' }, 429);

  const id = crypto.randomUUID();
  calls++;
  await putBlob(id, request.body); // streaming: sin materializar el bundle acá
  calls++;
  await putPending({ id, op: 'importBundle', args: { name: params.name }, blobId: id });

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
      return json(result.value ?? null, 200);
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
