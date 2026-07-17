// GET /api/health — espejo de GET /health de rag-server.mjs.
import { json } from './_queue.js';
export const onRequestGet = () => json({ ok: true, runtime: 'browser-worker' });
