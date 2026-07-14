import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RagEngine } from './rag-engine.mjs';

function memPersistence() {
  const m = new Map();
  return {
    async save(name, buf) { m.set(name, buf); },
    async load(name) { return m.get(name) ?? null; },
    async list() { return [...m.keys()]; },
    async delete(name) { m.delete(name); },
  };
}

const embedFn = async () => { const v = new Array(8).fill(0.1); v[0] = 1; return v; };

const DOC = { id: 'd1', md: '---\ntype: Nota técnica\ntitle: Documento uno\ndescription: Descripcion suficientemente larga.\ntags: [a, b]\n---\n\n# Resumen\n\nCuerpo.' };

test('deleteCollection inexistente lanza con el nombre en el mensaje', async () => {
  const eng = new RagEngine({ embedFn, persistence: memPersistence(), dim: 8 });
  await assert.rejects(() => eng.deleteCollection('no-existe'), (e) => e.message.includes('no-existe'));
});

test('deleteCollection existente sigue funcionando', async () => {
  const eng = new RagEngine({ embedFn, persistence: memPersistence(), dim: 8 });
  await eng.createCollection('c', [DOC]);
  await eng.deleteCollection('c');
  assert.deepEqual(await eng.listCollections(), []);
});

test('tool.js con path params usa encodeURIComponent', () => {
  const query = readFileSync('./skills/rag_query/tool.js', 'utf8');
  assert.ok(query.includes('encodeURIComponent'), 'rag_query');
  const hasRawConcat = /"\/collections\/"\s*\+\s*args\.collection\b(?!\s*\)|.*encodeURIComponent)/.test(query);
  assert.ok(query.includes('encodeURIComponent(args.collection)'), 'rag_query debe encodear collection');
});