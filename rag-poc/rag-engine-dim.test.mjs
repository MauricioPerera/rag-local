import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RagEngine } from './rag-engine.mjs';

function fakeEmbedOfDim(dim) {
  return async (text) => {
    const v = new Array(dim).fill(0.01);
    v[text.length % dim] = 1;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map(x => x / n);
  };
}

function memPersistence() {
  const m = new Map();
  return {
    async save(name, buf) { m.set(name, buf); },
    async load(name) { return m.get(name) ?? null; },
    async list() { return [...m.keys()]; },
    async delete(name) { m.delete(name); },
  };
}

const okfDoc = (id, title) =>
  ({ id, md: `---\ntype: Nota técnica\ntitle: ${title}\ndescription: Documento de prueba con descripcion larga.\ntags: [a, b]\n---\n\n# Resumen\n\nCuerpo.` });

const DOCS = [okfDoc('d1', 'Primer documento'), okfDoc('d2', 'Segundo documento')];

test('bundle de dim distinta es rechazado en import con mensaje que incluye ambas dims', async () => {
  const eng256 = new RagEngine({ embedFn: fakeEmbedOfDim(256), persistence: memPersistence(), dim: 256 });
  await eng256.createCollection('c', DOCS);
  const buf = await eng256.exportBundle('c');

  const eng768 = new RagEngine({ embedFn: fakeEmbedOfDim(768), persistence: memPersistence(), dim: 768 });
  await assert.rejects(
    () => eng768.importBundle('c', buf),
    (e) => e.message.includes('dim') && e.message.includes('256') && e.message.includes('768'),
  );
  assert.deepEqual(await eng768.listCollections(), []);
});

test('bundle de dim correcta se importa igual que antes', async () => {
  const a = new RagEngine({ embedFn: fakeEmbedOfDim(64), persistence: memPersistence(), dim: 64 });
  await a.createCollection('c', DOCS);
  const buf = await a.exportBundle('c');
  const b = new RagEngine({ embedFn: fakeEmbedOfDim(64), persistence: memPersistence(), dim: 64 });
  const r = await b.importBundle('c', buf);
  assert.deepEqual(r, { name: 'c', count: 2 });
  const res = await b.query('c', 'x', 1);
  assert.equal(res.length, 1);
});

test('carga desde persistencia con dim errada tambien falla (defensivo)', async () => {
  const p = memPersistence();
  const a = new RagEngine({ embedFn: fakeEmbedOfDim(32), persistence: p, dim: 32 });
  await a.createCollection('c', DOCS);
  // misma persistencia, engine con otra dim: query debe rechazar, no devolver basura
  const b = new RagEngine({ embedFn: fakeEmbedOfDim(768), persistence: p, dim: 768 });
  await assert.rejects(() => b.query('c', 'x', 1), (e) => e.message.includes('dim'));
});