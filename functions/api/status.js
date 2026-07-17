// GET /api/status -> { worker, ready, dir, collections, seen_ago_s }
// Si hay una pestaña escuchando y si su engine está armado (carpeta elegida +
// modelo cargado). El estado lo reporta la pestaña en cada long-poll: sin
// heartbeat, sin requests extra.

import { getState, json } from './_queue.js';
import { checkAuth } from './_auth.js';

const STALE_MS = 70000; // la pestaña pollea cada ~25s

export async function onRequestGet({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  const state = await getState();
  if (!state) return json({ worker: false, ready: false, note: 'ninguna pestaña reportó todavía' });

  const ageMs = Date.now() - (state.at || 0);
  const alive = ageMs < STALE_MS;
  return json({
    worker: alive,
    ready: alive ? !!state.ready : false,
    dir: state.dir || '',
    collections: state.collections || 0,
    seen_ago_s: Math.round(ageMs / 1000),
  });
}
