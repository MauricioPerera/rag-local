import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './rag-server.mjs';
import { fsPersistence } from './fs-persistence.mjs';
import { RagEngine } from '../rag-poc/rag-engine.mjs';

const PORT = 18941;
const BASE = `http://localhost:${PORT}`;
const DIM = 8;
const embedFn = async (text) => {
  const v = new Array(DIM).fill(0.01);
  v[text.includes('gato') ? 0 : 1] = 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / n);
};

const DOC = { id: 'd-gato', md: '---\ntype: Nota técnica\ntitle: Sobre el gato\ndescription: Documento que habla del gato domestico.\ntags: [gato]\n---\n\n# Resumen\n\nGatos.' };

async function withServer(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ragsrv-'));
  const staticDir = mkdtempSync(join(tmpdir(), 'ragstatic-'));
  writeFileSync(join(staticDir, 'llms.txt'), '## Skills\n- [x](/skills/x/SKILL.md): x\n');
  mkdirSync(join(staticDir, 'skills', 'x'), { recursive: true });
  writeFileSync(join(staticDir, 'skills', 'x', 'tool.js'), 'registerTool({name:"x"});');
  const engine = new RagEngine({ embedFn, persistence: fsPersistence(dataDir), dim: DIM });
  const s = startServer({ port: PORT, engine, staticRoot: staticDir });
  await new Promise(r => setTimeout(r, 100));
  try { await fn(); } finally {
    await s.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(staticDir, { recursive: true, force: true });
  }
}

test('flujo completo: health, create, list, query, export/import, delete', async () => {
  await withServer(async () => {
    const h = await (await fetch(`${BASE}/health`)).json();
    assert.deepEqual(h, { ok: true, hostConnected: true });

    const c = await fetch(`${BASE}/collections`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'animales', docs: [DOC] }),
    });
    assert.equal(c.status, 200);
    assert.deepEqual(await c.json(), { name: 'animales', count: 1 });

    assert.deepEqual(await (await fetch(`${BASE}/collections`)).json(), ['animales']);

    const q = await fetch(`${BASE}/collections/animales/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'donde esta el gato', k: 1 }),
    });
    const results = await q.json();
    assert.equal(results[0].id, 'd-gato');
    assert.ok(results[0].md.includes('# Resumen'));

    const exp = await fetch(`${BASE}/collections/animales/export`);
    assert.equal(exp.headers.get('content-type'), 'application/octet-stream');
    const buf = await exp.arrayBuffer();
    assert.equal(new DataView(buf).getUint32(0, false), 0x4a565342);

    const imp = await fetch(`${BASE}/collections/copia/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
    });
    assert.deepEqual(await imp.json(), { name: 'copia', count: 1 });

    const del = await fetch(`${BASE}/collections/copia`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual(await (await fetch(`${BASE}/collections`)).json(), ['animales']);
  });
});

test('error del engine → 502 con mensaje', async () => {
  await withServer(async () => {
    const r = await fetch(`${BASE}/collections/no-existe/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(r.status, 502);
    assert.ok((await r.json()).error.includes('no-existe'));
  });
});

test('origin malicioso → 403; estáticos servidos con origin permitido', async () => {
  await withServer(async () => {
    const bad = await fetch(`${BASE}/collections`, { headers: { Origin: 'https://evil.com' } });
    assert.equal(bad.status, 403);
    const ok = await fetch(`${BASE}/llms.txt`, { headers: { Origin: 'http://localhost:1234' } });
    assert.equal(ok.status, 200);
    assert.ok((await ok.text()).includes('## Skills'));
    const tj = await fetch(`${BASE}/skills/x/tool.js`);
    assert.ok(tj.headers.get('content-type').startsWith('text/javascript'));
  });
});

test('persistencia FS sobrevive reinicio del server', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ragsrv2-'));
  const mk = () => new RagEngine({ embedFn, persistence: fsPersistence(dataDir), dim: DIM });
  let s = startServer({ port: PORT, engine: mk(), staticRoot: dataDir });
  await new Promise(r => setTimeout(r, 100));
  await fetch(`${BASE}/collections`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'animales', docs: [DOC] }),
  });
  await s.close();
  s = startServer({ port: PORT, engine: mk(), staticRoot: dataDir });
  await new Promise(r => setTimeout(r, 100));
  try {
    const list = await (await fetch(`${BASE}/collections`)).json();
    assert.deepEqual(list, ['animales']);
    const q = await fetch(`${BASE}/collections/animales/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'gato', k: 1 }),
    });
    assert.equal((await q.json())[0].id, 'd-gato');
  } finally {
    await s.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});