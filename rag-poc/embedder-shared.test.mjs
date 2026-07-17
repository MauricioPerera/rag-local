// embedder-shared.test.mjs
//
// Prueba la lógica que define el vector (prefijos + normalización) y el embedder
// del navegador, con dobles en lugar del modelo de 316MB. El test del modelo
// real es rag-node/embedder-node.test.mjs, que sí lo descarga.
//
// El test que más importa acá es el último: que ninguno de los dos embedders
// tenga su propia copia de los prefijos. Ese es el modo de falla que rompe la
// interop entre Node y navegador sin tirar un solo error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PREFIXES, MODEL_ID, promptFor, l2Normalize, makeEmbedFn } from './embedder-shared.mjs';
import { createEmbedder, _resetForTests } from './embedder-browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ── prefijos ───────────────────────────────────────────────────────────────

test('promptFor aplica el prefijo asimétrico de cada modo', () => {
  assert.equal(promptFor('hola', 'query'), 'task: search result | query: hola');
  assert.equal(promptFor('hola', 'document'), 'title: none | text: hola');
  assert.equal(promptFor('hola', 'similarity'), 'task: sentence similarity | query: hola');
});

test('promptFor cae a similarity con un modo desconocido o ausente', () => {
  assert.equal(promptFor('hola', 'inventado'), PREFIXES.similarity + 'hola');
  assert.equal(promptFor('hola', undefined), PREFIXES.similarity + 'hola');
});

// ── normalización ──────────────────────────────────────────────────────────

test('l2Normalize deja norma 1', () => {
  const out = l2Normalize([3, 4]); // norma 5
  assert.deepEqual(out, [0.6, 0.8]);
  const n = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(n - 1) < 1e-12);
});

test('l2Normalize no divide por cero con el vector nulo', () => {
  assert.deepEqual(l2Normalize([0, 0, 0]), [0, 0, 0]);
});

// ── makeEmbedFn con dobles ─────────────────────────────────────────────────

// Tokenizer/model falsos: el "model" devuelve un vector sin normalizar cuya
// primera componente delata qué prompt recibió, así el test puede afirmar que
// el prefijo llegó de verdad hasta el modelo.
function fakes() {
  const visto = [];
  const tokenizer = (texto) => { visto.push(texto); return { texto }; };
  const model = async (inputs) => ({
    sentence_embedding: { tolist: () => [[inputs.texto.length, 3, 4]] },
  });
  return { tokenizer, model, visto };
}

test('makeEmbedFn manda el texto CON prefijo al tokenizer y normaliza la salida', async () => {
  const { tokenizer, model, visto } = fakes();
  const embedFn = makeEmbedFn({ tokenizer, model });

  const v = await embedFn('gato', 'document');
  assert.deepEqual(visto, ['title: none | text: gato']);

  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(n - 1) < 1e-12, `esperaba norma 1, dio ${n}`);
});

test('makeEmbedFn: el mismo texto en modos distintos da vectores distintos', async () => {
  const { tokenizer, model } = fakes();
  const embedFn = makeEmbedFn({ tokenizer, model });
  const q = await embedFn('hola mundo', 'query');
  const d = await embedFn('hola mundo', 'document');
  assert.ok(q.some((v, i) => Math.abs(v - d[i]) > 1e-9), 'query y document deben diferir');
});

// ── embedder del navegador ─────────────────────────────────────────────────

function fakeTransformers() {
  const cargas = [];
  return {
    cargas,
    mod: {
      AutoTokenizer: { from_pretrained: async (id) => { cargas.push(['tok', id]); return fakes().tokenizer; } },
      AutoModel: {
        from_pretrained: async (id, opts) => {
          cargas.push(['model', id, opts]);
          return async (inputs) => ({ sentence_embedding: { tolist: () => [[inputs.texto.length, 3, 4]] } });
        },
      },
    },
  };
}

test('createEmbedder (navegador) carga el MODEL_ID compartido y embebe', async () => {
  _resetForTests();
  const t = fakeTransformers();
  const { embedFn } = await createEmbedder({ transformers: t.mod });
  const v = await embedFn('gato', 'query');
  assert.equal(v.length, 3);
  assert.equal(t.cargas[0][1], MODEL_ID, 'debe pedir el mismo modelo que Node');
  assert.equal(t.cargas[1][2].dtype, 'q8', 'dtype por defecto q8, igual que Node');
});

test('createEmbedder (navegador): sin device no fuerza nada (transformers elige, cae a WASM)', async () => {
  _resetForTests();
  const t = fakeTransformers();
  await createEmbedder({ transformers: t.mod });
  assert.equal('device' in t.cargas[1][2], false, 'no debe fijar device si no se lo pidieron');
});

test('createEmbedder (navegador) pasa device cuando se lo piden', async () => {
  _resetForTests();
  const t = fakeTransformers();
  await createEmbedder({ transformers: t.mod, device: 'webgpu' });
  assert.equal(t.cargas[1][2].device, 'webgpu');
});

test('createEmbedder (navegador) es singleton: no recarga el modelo', async () => {
  _resetForTests();
  const t = fakeTransformers();
  await createEmbedder({ transformers: t.mod });
  await createEmbedder({ transformers: t.mod });
  assert.equal(t.cargas.filter((c) => c[0] === 'model').length, 1, 'el modelo se carga una sola vez');
});

// La primera carga tarda ~94s (medido en Chrome). Sin progreso es indistinguible
// de una pestaña colgada, así que el callback tiene que llegar a los DOS
// from_pretrained: el tokenizer y el modelo.
test('createEmbedder (navegador) pasa onProgress como progress_callback al tokenizer y al modelo', async () => {
  _resetForTests();
  const vistos = [];
  const mod = {
    AutoTokenizer: { from_pretrained: async (_id, opts) => { vistos.push(['tok', opts?.progress_callback]); return fakes().tokenizer; } },
    AutoModel: {
      from_pretrained: async (_id, opts) => {
        vistos.push(['model', opts?.progress_callback]);
        return async (inputs) => ({ sentence_embedding: { tolist: () => [[inputs.texto.length, 3, 4]] } });
      },
    },
  };
  const onProgress = () => {};
  await createEmbedder({ transformers: mod, onProgress });
  assert.equal(vistos.length, 2);
  assert.equal(vistos[0][1], onProgress, 'el tokenizer debe recibir el callback');
  assert.equal(vistos[1][1], onProgress, 'el modelo debe recibir el callback');
});

test('createEmbedder (navegador) sin onProgress no inventa un progress_callback', async () => {
  _resetForTests();
  const t = fakeTransformers();
  await createEmbedder({ transformers: t.mod });
  assert.equal('progress_callback' in t.cargas[1][2], false);
});

// ── el guard que protege la interop ────────────────────────────────────────

test('ningún embedder tiene su propia copia de los prefijos ni del MODEL_ID', async () => {
  const archivos = [
    ['embedder-browser.mjs', path.join(here, 'embedder-browser.mjs')],
    ['embedder-node.mjs', path.join(here, '..', 'rag-node', 'embedder-node.mjs')],
  ];
  for (const [nombre, ruta] of archivos) {
    const src = await readFile(ruta, 'utf8');
    const codigo = src.replace(/\/\/[^\n]*/g, ''); // los comentarios pueden nombrarlos
    assert.ok(
      !/PREFIXES\s*=/.test(codigo),
      `${nombre} redefine PREFIXES: los prompts tienen que salir de embedder-shared.mjs o las colecciones se vuelven incompatibles en silencio`
    );
    assert.ok(
      !/MODEL_ID\s*=\s*['"]/.test(codigo),
      `${nombre} redefine MODEL_ID: tiene que salir de embedder-shared.mjs`
    );
    assert.ok(
      /from '.*embedder-shared\.mjs'/.test(codigo),
      `${nombre} debe importar de embedder-shared.mjs`
    );
  }
});
