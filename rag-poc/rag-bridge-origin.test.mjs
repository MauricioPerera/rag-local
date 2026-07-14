import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge } from './rag-bridge.mjs';

const PORT = 18939;
const BASE = `http://localhost:${PORT}`;

async function withBridge(opts, fn) {
  const b = startBridge({ port: PORT, ...opts });
  await new Promise(r => setTimeout(r, 100));
  try { await fn(); } finally { await b.close(); }
}

test('origin malicioso → 403 en collections, health y estáticos', async () => {
  await withBridge({}, async () => {
    for (const p of ['/collections', '/health', '/llms.txt', '/skills/x/tool.js']) {
      const r = await fetch(`${BASE}${p}`, { headers: { Origin: 'https://evil.com' } });
      assert.equal(r.status, 403, p);
      assert.deepEqual(await r.json(), { error: 'origin not allowed' });
    }
  });
});

test('origin malicioso no encola jobs: host/poll posterior no recibe nada', async () => {
  await withBridge({}, async () => {
    await fetch(`${BASE}/host/poll`); // registra host
    const r = await fetch(`${BASE}/collections`, { headers: { Origin: 'https://evil.com' } });
    assert.equal(r.status, 403);
    const poll = await fetch(`${BASE}/host/poll`);
    assert.equal(poll.status, 204);
  });
});

test('origin localhost permitido con cualquier puerto y echo en ACAO', async () => {
  await withBridge({}, async () => {
    const r = await fetch(`${BASE}/health`, { headers: { Origin: 'http://localhost:8936' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8936');
    const r2 = await fetch(`${BASE}/health`, { headers: { Origin: 'http://127.0.0.1:5500' } });
    assert.equal(r2.status, 200);
  });
});

test('sin Origin → permitido y ACAO *', async () => {
  await withBridge({}, async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });
});

test('allowedOrigins agrega origins exactos', async () => {
  await withBridge({ allowedOrigins: ['https://miapp.example'] }, async () => {
    const ok = await fetch(`${BASE}/health`, { headers: { Origin: 'https://miapp.example' } });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${BASE}/health`, { headers: { Origin: 'https://otra.example' } });
    assert.equal(bad.status, 403);
  });
});

test('OPTIONS sigue 204 incluso con origin malicioso (preflight inofensivo)', async () => {
  await withBridge({}, async () => {
    const r = await fetch(`${BASE}/collections`, { method: 'OPTIONS', headers: { Origin: 'https://evil.com' } });
    assert.equal(r.status, 204);
  });
});