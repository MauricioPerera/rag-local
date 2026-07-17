// fsa-persistence.test.mjs
//
// Corre EL MISMO contrato contra los dos adapters de persistencia: el de Node
// (fs, carpeta real) y el del navegador (File System Access, con un handle
// falso). Que pasen los dos es lo que respalda la promesa del diseño: los .jvsb
// son intercambiables, así que rag-server.mjs y una pestaña pueden compartir la
// misma carpeta de colecciones.
//
// El handle falso no es un atajo: File System Access no existe en Node, y el
// engine ya recibe la persistencia inyectada, así que mockear el handle prueba
// exactamente la capa que escribimos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fsaPersistence } from './fsa-persistence.mjs';
import { fsPersistence } from '../rag-node/fs-persistence.mjs';
import { RagEngine } from './rag-engine.mjs';

// ── FileSystemDirectoryHandle falso ────────────────────────────────────────
// Implementa lo que usa el adapter: getFileHandle, removeEntry y values().
function fakeDirHandle() {
  const files = new Map(); // nombre -> Uint8Array
  const notFound = () => {
    const e = new Error('not found');
    e.name = 'NotFoundError'; // lo que tira el navegador de verdad
    throw e;
  };
  return {
    _files: files,
    async getFileHandle(name, opts = {}) {
      if (!files.has(name) && !opts.create) notFound();
      return {
        name,
        async getFile() {
          if (!files.has(name)) notFound();
          const bytes = files.get(name);
          return { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
        },
        async createWritable() {
          const chunks = [];
          return {
            async write(d) { chunks.push(new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer)); },
            async abort() {},
            async close() {
              const total = chunks.reduce((n, c) => n + c.length, 0);
              const out = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) { out.set(c, off); off += c.length; }
              files.set(name, out);
            },
          };
        },
      };
    },
    async removeEntry(name) {
      if (!files.has(name)) notFound();
      files.delete(name);
    },
    async *values() {
      for (const name of files.keys()) yield { kind: 'file', name };
    },
  };
}

const bytes = (n, seed = 1) => {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * seed + 13) % 256;
  return u;
};

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'ragfs-'));

// ── El contrato, idéntico para los dos ─────────────────────────────────────
function contrato(nombre, crear) {
  test(`${nombre}: save + load devuelve exactamente los mismos bytes`, async () => {
    const p = await crear();
    const data = bytes(2048);
    await p.save('mi-col', data.buffer);
    const got = await p.load('mi-col');
    assert.ok(got instanceof ArrayBuffer, 'load debe devolver un ArrayBuffer puro');
    assert.deepEqual(new Uint8Array(got), data);
  });

  test(`${nombre}: load de una colección inexistente devuelve null`, async () => {
    const p = await crear();
    assert.equal(await p.load('no-existe'), null);
  });

  test(`${nombre}: save sobrescribe (no concatena)`, async () => {
    const p = await crear();
    await p.save('col', bytes(500, 3).buffer);
    await p.save('col', bytes(80, 9).buffer);
    const got = await p.load('col');
    assert.equal(got.byteLength, 80);
    assert.deepEqual(new Uint8Array(got), bytes(80, 9));
  });

  test(`${nombre}: list devuelve nombres sin extensión y ordenados`, async () => {
    const p = await crear();
    await p.save('zeta', bytes(4).buffer);
    await p.save('alfa', bytes(4).buffer);
    await p.save('m3dio', bytes(4).buffer);
    assert.deepEqual(await p.list(), ['alfa', 'm3dio', 'zeta']);
  });

  test(`${nombre}: delete borra, y es idempotente si no existe`, async () => {
    const p = await crear();
    await p.save('col', bytes(4).buffer);
    await p.delete('col');
    assert.deepEqual(await p.list(), []);
    await p.delete('col'); // no debe tirar
  });

  test(`${nombre}: rechaza nombres inválidos (path traversal incluido)`, async () => {
    const p = await crear();
    for (const malo of ['../evil', 'a/b', 'ABC', '', '-arranca-con-guion', '.oculto', 'con espacio']) {
      await assert.rejects(() => p.save(malo, new ArrayBuffer(1)), /inválido/, `save("${malo}")`);
      await assert.rejects(() => p.load(malo), /inválido/, `load("${malo}")`);
      await assert.rejects(() => p.delete(malo), /inválido/, `delete("${malo}")`);
    }
  });
}

contrato('fs (Node)', async () => fsPersistence(await tmpDir()));
contrato('fsa (navegador)', async () => fsaPersistence(fakeDirHandle()));

// ── Lo que realmente importa: que sean la misma carpeta ────────────────────

test('interop: los dos adapters escriben el mismo archivo con los mismos bytes', async () => {
  const data = bytes(777, 7);

  const dir = await tmpDir();
  await fsPersistence(dir).save('compartida', data.buffer);
  const enDisco = await fsp.readFile(path.join(dir, 'compartida.jvsb'));

  const handle = fakeDirHandle();
  await fsaPersistence(handle).save('compartida', data.buffer);

  assert.ok(handle._files.has('compartida.jvsb'), 'mismo nombre de archivo');
  assert.deepEqual(handle._files.get('compartida.jvsb'), new Uint8Array(enDisco), 'mismos bytes');
});

test('interop: el navegador lee una colección que escribió rag-server (Node)', async () => {
  const data = bytes(1234, 5);
  const dir = await tmpDir();
  await fsPersistence(dir).save('desde-node', data.buffer);

  // Sembrar el handle con el archivo REAL que dejó el adapter de Node.
  const handle = fakeDirHandle();
  handle._files.set('desde-node.jvsb', new Uint8Array(await fsp.readFile(path.join(dir, 'desde-node.jvsb'))));

  const got = await fsaPersistence(handle).load('desde-node');
  assert.deepEqual(new Uint8Array(got), data);
  assert.deepEqual(await fsaPersistence(handle).list(), ['desde-node']);
});

test('interop: Node lee una colección que escribió el navegador', async () => {
  const data = bytes(999, 11);
  const handle = fakeDirHandle();
  await fsaPersistence(handle).save('desde-browser', data.buffer);

  // Volcar lo que "escribió el navegador" en una carpeta real y leerlo con Node.
  const dir = await tmpDir();
  await fsp.writeFile(path.join(dir, 'desde-browser.jvsb'), handle._files.get('desde-browser.jvsb'));

  const got = await fsPersistence(dir).load('desde-browser');
  assert.deepEqual(new Uint8Array(got), data);
});

test('fsaPersistence rechaza algo que no sea un directory handle', () => {
  assert.throws(() => fsaPersistence(null), /FileSystemDirectoryHandle/);
  assert.throws(() => fsaPersistence({}), /FileSystemDirectoryHandle/);
});

// ── Lo decisivo: el engine REAL contra el adapter del navegador ────────────
// Lo de arriba valida el contrato tal como YO lo leí. Esto lo valida contra
// quien lo consume de verdad. Mismo embedder fake determinista que
// rag-engine.test.mjs.

const DIM = 8;
const embedFn = async (text) => {
  const v = new Array(DIM).fill(0.01);
  if (text.includes('gato')) v[0] = 1;
  else if (text.includes('perro')) v[1] = 1;
  else if (text.includes('auto')) v[2] = 1;
  else v[3] = 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};

const okfDoc = (id, title, desc, tags) => ({
  id,
  md: `---\ntype: Nota técnica\ntitle: ${title}\ndescription: ${desc}\ntags: [${tags.join(', ')}]\n---\n\n# Resumen\n\n${desc}`,
});

const DOCS = [
  okfDoc('d1', 'Gatos', 'Todo sobre el gato domestico', ['gato']),
  okfDoc('d2', 'Perros', 'Todo sobre el perro y su cuidado', ['perro']),
  okfDoc('d3', 'Autos', 'Mantenimiento del auto electrico', ['auto']),
];

test('engine real + fsaPersistence: crear, listar, consultar y borrar', async () => {
  const engine = new RagEngine({ embedFn, persistence: fsaPersistence(fakeDirHandle()), dim: DIM });

  await engine.createCollection('animales', DOCS);
  assert.deepEqual(await engine.listCollections(), ['animales']);

  const hits = await engine.query('animales', 'el gato', 2);
  assert.ok(hits.length > 0, 'debe recuperar algo');
  assert.equal(hits[0].id, 'd1', 'el doc del gato debe salir primero');

  await engine.deleteCollection('animales');
  assert.deepEqual(await engine.listCollections(), []);
});

test('engine real: un bundle exportado en Node se importa en el navegador y consulta igual', async () => {
  // Indexar con el adapter de Node, como haría rag-server.mjs.
  const dir = await tmpDir();
  const enNode = new RagEngine({ embedFn, persistence: fsPersistence(dir), dim: DIM });
  await enNode.createCollection('animales', DOCS);
  const bundle = await enNode.exportBundle('animales');

  // Importarlo con el adapter del navegador y consultar la MISMA colección.
  const enBrowser = new RagEngine({ embedFn, persistence: fsaPersistence(fakeDirHandle()), dim: DIM });
  await enBrowser.importBundle('animales', bundle);

  const hits = await enBrowser.query('animales', 'el gato', 2);
  assert.equal(hits[0].id, 'd1');
  assert.deepEqual(
    (await enNode.query('animales', 'el gato', 2)).map((h) => h.id),
    hits.map((h) => h.id),
    'mismos resultados de un lado y del otro'
  );
});
