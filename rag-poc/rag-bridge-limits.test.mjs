import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge } from './rag-bridge.mjs';

const PORT = 18940;
const BASE = `http://localhost:${PORT}`;

async function withBridge(opts, fn) {
  const b = startBridge({ port: PORT, ...opts });
  await new Promise(r => setTimeout(r, 100));
  try { await fn(); } finally { await b.close(); }
}

test('body que excede maxBodyBytes → 413', async () => {
  await withBridge({ maxBodyBytes: 1024 }, async () => {
    await fetch(`${BASE}/host/poll`); // host conectado
    const big = 'x'.repeat(4096);
    const r = await fetch(`${BASE}/collections/c/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: big,
    });
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: 'body too large' });
  });
});

test('body dentro del limite pasa normal', async () => {
  await withBridge({ maxBodyBytes: 1024 }, async () => {
    await fetch(`${BASE}/host/poll`);
    const pending = fetch(`${BASE}/collections/c/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hola' }),
    });
    // atender el job para que el request resuelva
    for (let i = 0; i < 50; i++) {
      const p = await fetch(`${BASE}/host/poll`);
      if (p.status === 200) {
        const job = await p.json();
        await fetch(`${BASE}/host/result`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.jobId, result: [] }),
        });
        break;
      }
      await new Promise(r2 => setTimeout(r2, 50));
    }
    const r = await pending;
    assert.equal(r.status, 200);
  });
});

test('timeout por metodo: default corto expira, createCollection largo sobrevive', async () => {
  await withBridge({ timeouts: { default: 300, createCollection: 1500 } }, async () => {
    await fetch(`${BASE}/host/poll`); // host "conectado" pero nunca responde jobs
    const t0 = Date.now();
    const rq = await fetch(`${BASE}/collections/c/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    const dtQuery = Date.now() - t0;
    assert.equal(rq.status, 504);
    assert.ok(dtQuery < 1200, `query tardo ${dtQuery}ms, esperaba ~300`);

    await fetch(`${BASE}/host/poll`); // refrescar hostConnected
    const t1 = Date.now();
    const rc = await fetch(`${BASE}/collections`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'c', docs: [] }),
    });
    const dtCreate = Date.now() - t1;
    assert.equal(rc.status, 504);
    assert.ok(dtCreate >= 1200, `create tardo ${dtCreate}ms, esperaba ~1500`);
  });
});