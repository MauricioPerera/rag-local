import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder } from './embedder-node.mjs';

function cos(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

test('embedder real: 768d, normalizado, y ranking semantico correcto', { timeout: 600000 }, async () => {
  const { embedFn } = await createEmbedder();

  const q = await embedFn('donde duerme el gato', 'query');
  assert.equal(q.length, 768);
  const norm = Math.sqrt(q.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, `norma=${norm}`);

  const dGato = await embedFn('El gato duerme en el sofa de la casa.', 'document');
  const dAuto = await embedFn('El auto electrico consume menos energia.', 'document');
  assert.equal(dGato.length, 768);

  const simGato = cos(q, dGato);
  const simAuto = cos(q, dAuto);
  assert.ok(simGato > simAuto, `esperaba gato(${simGato}) > auto(${simAuto})`);
  assert.ok(simGato > 0.3, `similitud gato demasiado baja: ${simGato}`);
});

test('modos producen prompts distintos (vectores distintos para el mismo texto)', { timeout: 600000 }, async () => {
  const { embedFn } = await createEmbedder();
  const a = await embedFn('hola mundo', 'query');
  const b = await embedFn('hola mundo', 'document');
  const same = a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  assert.ok(!same, 'query y document deben producir embeddings distintos');
});