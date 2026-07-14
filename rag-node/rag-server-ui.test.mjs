import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './rag-server.mjs';
import { RagEngine } from '../rag-poc/rag-engine.mjs';

const PORT = 18942;
const BASE = `http://localhost:${PORT}`;
const embedFn = async () => { const v = new Array(8).fill(0.1); v[0] = 1; return v; };
const mem = () => { const m = new Map(); return { async save(n,b){m.set(n,b);}, async load(n){return m.get(n)??null;}, async list(){return [...m.keys()];}, async delete(n){m.delete(n);} }; };

async function withUiServer(fn) {
  const uiRoot = mkdtempSync(join(tmpdir(), 'ragui-'));
  writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>RAG Local</title><h1>ui-fixture</h1>');
  writeFileSync(join(uiRoot, 'app.mjs'), 'console.log("ui");');
  writeFileSync(join(uiRoot, 'styles.css'), 'body{}');
  const engine = new RagEngine({ embedFn, persistence: mem(), dim: 8 });
  const s = startServer({ port: PORT, engine, staticRoot: uiRoot, uiRoot });
  await new Promise(r => setTimeout(r, 100));
  try { await fn(); } finally { await s.close(); rmSync(uiRoot, { recursive: true, force: true }); }
}

test('GET / sirve index.html como text/html', async () => {
  await withUiServer(async () => {
    const r = await fetch(`${BASE}/`);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-type').startsWith('text/html'));
    assert.ok((await r.text()).includes('ui-fixture'));
  });
});

test('GET /ui/app.mjs como text/javascript y /ui/styles.css como text/css', async () => {
  await withUiServer(async () => {
    const j = await fetch(`${BASE}/ui/app.mjs`);
    assert.ok(j.headers.get('content-type').startsWith('text/javascript'));
    const c = await fetch(`${BASE}/ui/styles.css`);
    assert.ok(c.headers.get('content-type').startsWith('text/css'));
  });
});

test('traversal en /ui rechazado y archivo inexistente 404', async () => {
  await withUiServer(async () => {
    const t = await fetch(`${BASE}/ui/..%2Frag-server.mjs`);
    assert.ok(t.status === 400 || t.status === 404);
    assert.equal((await fetch(`${BASE}/ui/nada.js`)).status, 404);
  });
});

test('la API sigue intacta con UI montada', async () => {
  await withUiServer(async () => {
    const h = await (await fetch(`${BASE}/health`)).json();
    assert.equal(h.ok, true);
    assert.deepEqual(await (await fetch(`${BASE}/collections`)).json(), []);
  });
});