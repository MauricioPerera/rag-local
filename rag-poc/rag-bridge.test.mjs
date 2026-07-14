import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge } from './rag-bridge.mjs';

const PORT = 18937;
const BASE = `http://localhost:${PORT}`;

async function withBridge(fn) {
  const b = startBridge({ port: PORT });
  await new Promise(r => setTimeout(r, 100));
  try { await fn(); } finally { await b.close(); }
}

// Host fake: pollea una vez, atiende el primer job con handler(method, params) y postea el resultado.
async function serveOneJob(handler) {
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${BASE}/host/poll`);
    if (r.status === 200) {
      const job = await r.json();
      const out = await handler(job.method, job.params);
      await fetch(`${BASE}/host/result`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.jobId, ...out }),
      });
      return job;
    }
    await new Promise(r2 => setTimeout(r2, 50));
  }
  throw new Error('no job arrived');
}

test('health sin host: hostConnected false', async () => {
  await withBridge(async () => {
    const r = await fetch(`${BASE}/health`);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.hostConnected, false);
  });
});

test('request sin host conectado devuelve 503', async () => {
  await withBridge(async () => {
    const r = await fetch(`${BASE}/collections`);
    assert.equal(r.status, 503);
  });
});

test('listCollections viaja al host y vuelve', async () => {
  await withBridge(async () => {
    await fetch(`${BASE}/host/poll`); // registra host
    const pending = fetch(`${BASE}/collections`);
    const job = await serveOneJob(async (method) => {
      assert.equal(method, 'listCollections');
      return { result: ['demo'] };
    });
    assert.ok(job.jobId);
    const r = await pending;
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), ['demo']);
  });
});

test('query pasa name, text y k en params', async () => {
  await withBridge(async () => {
    await fetch(`${BASE}/host/poll`);
    const pending = fetch(`${BASE}/collections/demo/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hola', k: 2 }),
    });
    await serveOneJob(async (method, params) => {
      assert.equal(method, 'query');
      assert.deepEqual(params, { name: 'demo', text: 'hola', k: 2 });
      return { result: [{ id: 'd1', score: 0.9 }] };
    });
    const r = await pending;
    assert.deepEqual(await r.json(), [{ id: 'd1', score: 0.9 }]);
  });
});

test('error del host se traduce a 502', async () => {
  await withBridge(async () => {
    await fetch(`${BASE}/host/poll`);
    const pending = fetch(`${BASE}/collections/nada/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    await serveOneJob(async () => ({ error: 'collection not found' }));
    const r = await pending;
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'collection not found' });
  });
});

test('export devuelve binario decodificado de base64', async () => {
  await withBridge(async () => {
    await fetch(`${BASE}/host/poll`);
    const bytes = new Uint8Array([74, 86, 83, 66, 1, 2, 3]);
    const pending = fetch(`${BASE}/collections/demo/export`);
    await serveOneJob(async (method, params) => {
      assert.equal(method, 'exportBundle');
      assert.equal(params.name, 'demo');
      return { result: { base64: Buffer.from(bytes).toString('base64') } };
    });
    const r = await pending;
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    const buf = new Uint8Array(await r.arrayBuffer());
    assert.deepEqual([...buf], [...bytes]);
  });
});

test('import manda el binario como base64 al host', async () => {
  await withBridge(async () => {
    await fetch(`${BASE}/host/poll`);
    const payload = new Uint8Array([9, 8, 7]);
    const pending = fetch(`${BASE}/collections/nueva/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: payload,
    });
    await serveOneJob(async (method, params) => {
      assert.equal(method, 'importBundle');
      assert.equal(params.name, 'nueva');
      assert.deepEqual([...Buffer.from(params.base64, 'base64')], [9, 8, 7]);
      return { result: { name: 'nueva', count: 3 } };
    });
    const r = await pending;
    assert.deepEqual(await r.json(), { name: 'nueva', count: 3 });
  });
});

test('ruta desconocida 404 y OPTIONS 204 con CORS', async () => {
  await withBridge(async () => {
    const r404 = await fetch(`${BASE}/nada`);
    assert.equal(r404.status, 404);
    const rOpt = await fetch(`${BASE}/collections`, { method: 'OPTIONS' });
    assert.equal(rOpt.status, 204);
    assert.equal(rOpt.headers.get('access-control-allow-origin'), '*');
  });
});