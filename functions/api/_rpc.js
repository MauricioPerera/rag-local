// _rpc.js — encolar una operación y esperar su resultado.
//
// Vive en un solo lugar a propósito. La espera está acotada por un límite duro
// de la plataforma, no por gusto: la Cache API permite solo 50 llamadas
// put/match/delete POR REQUEST en el plan Free (1.000 en Paid), y comparten
// cuota con los subrequests. Un poll fijo de 400ms lo agota a los ~20s: las
// consultas cortas pasarían y las largas fallarían sin motivo aparente. De ahí
// el backoff exponencial. Duplicar esta lógica en cada endpoint es la forma
// segura de que se desincronice.

import { getPending, putPending, clearPending, takeResult, json } from './_queue.js';

const MAX_CACHE_CALLS = 45; // de las 50/request del plan Free; el resto es margen
const CLAIM_TIMEOUT_MS = 15000; // una pestaña tiene que agarrar el trabajo en este plazo
const FIRST_DELAY_MS = 200; // una query tarda ~180ms: conviene mirar temprano
const BACKOFF = 1.35;
const MAX_DELAY_MS = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Encola { op, args } para la pestaña y espera la respuesta.
 * @param {string} op - operación permitida (la pestaña tiene su allowlist).
 * @param {object} args
 * @returns {Promise<Response>}
 */
export async function rpc(op, args) {
  let calls = 0;

  // Un engine, un modelo, un trabajo a la vez.
  calls++;
  if (await getPending()) return json({ error: 'busy — hay otra operación en curso' }, 429);

  const id = crypto.randomUUID();
  calls++;
  await putPending({ id, op, args });

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

    // Una sola comprobación de "¿hay alguna pestaña escuchando?", para que no se
    // coma el presupuesto.
    if (!claimChecked && Date.now() - startedAt > CLAIM_TIMEOUT_MS) {
      claimChecked = true;
      calls++;
      const still = await getPending();
      if (still && still.id === id) {
        calls++;
        await clearPending();
        return json(
          { error: 'no hay worker — abrí rag-web en una pestaña, elegí la carpeta y cargá el modelo' },
          503
        );
      }
    }
  }

  return json({ error: 'timeout esperando a la pestaña', ms: Date.now() - startedAt }, 504);
}
