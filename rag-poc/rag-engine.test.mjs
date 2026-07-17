import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RagEngine } from './rag-engine.mjs';

const DIM = 8;
// Embedder fake determinista: vectores casi-ortogonales por keyword.
function fakeEmbed(text) {
  const v = new Array(DIM).fill(0.01);
  if (text.includes('gato')) v[0] = 1;
  else if (text.includes('perro')) v[1] = 1;
  else if (text.includes('auto')) v[2] = 1;
  else v[3] = 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / n);
}
const embedFn = async (text, _mode) => fakeEmbed(text);

function memPersistence() {
  const m = new Map();
  return {
    async save(name, buf) { m.set(name, buf); },
    async load(name) { return m.get(name) ?? null; },
    async list() { return [...m.keys()]; },
    async delete(name) { m.delete(name); },
    _map: m,
  };
}

const okfDoc = (id, title, desc, tags) =>
  ({ id, md: `---\ntype: Nota técnica\ntitle: ${title}\ndescription: ${desc}\ntags: [${tags.join(', ')}]\n---\n\n# Resumen\n\n${desc}` });

const DOCS = [
  okfDoc('d-gato', 'Sobre el gato', 'Un documento que habla del gato domestico.', ['gato', 'animales']),
  okfDoc('d-perro', 'Sobre el perro', 'Un documento que habla del perro domestico.', ['perro', 'animales']),
  okfDoc('d-auto', 'Sobre el auto', 'Un documento que habla del auto electrico.', ['auto', 'vehiculos']),
];

test('createCollection valida y persiste', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const r = await eng.createCollection('animales', DOCS);
  assert.deepEqual(r, { name: 'animales', count: 3 });
  assert.deepEqual(await eng.listCollections(), ['animales']);
});

test('createCollection rechaza docs invalidos sin persistir y nombra los ids', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const bad = [DOCS[0], { id: 'd-mal', md: '---\ntype: X\ntitle: ab\ndescription: corta\n---\nbody' }];
  await assert.rejects(() => eng.createCollection('mala', bad), (e) => e.message.includes('d-mal'));
  assert.deepEqual(await eng.listCollections(), []);
});

test('createCollection rechaza nombre invalido y duplicado', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await assert.rejects(() => eng.createCollection('Nombre Malo!', DOCS));
  await eng.createCollection('animales', DOCS);
  await assert.rejects(() => eng.createCollection('animales', DOCS));
});

test('query recupera el doc correcto con metadata completa', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', DOCS);
  const res = await eng.query('animales', 'donde esta el gato', 2);
  assert.equal(res.length, 2);
  assert.equal(res[0].id, 'd-gato');
  assert.ok(res[0].score > res[1].score);
  assert.equal(res[0].title, 'Sobre el gato');
  assert.equal(res[0].type, 'Nota técnica');
  assert.deepEqual(res[0].tags, ['gato', 'animales']);
  assert.ok(res[0].md.includes('# Resumen'));
});

test('query sobre coleccion inexistente lanza', async () => {
  const eng = new RagEngine({ embedFn, persistence: memPersistence(), dim: DIM });
  await assert.rejects(() => eng.query('nada', 'x', 1));
});

test('export produce bundle JVSB e import lo restaura en otra instancia', async () => {
  const p1 = memPersistence();
  const eng1 = new RagEngine({ embedFn, persistence: p1, dim: DIM });
  await eng1.createCollection('animales', DOCS);
  const buf = await eng1.exportBundle('animales');
  assert.ok(buf instanceof ArrayBuffer && buf.byteLength > 0);
  assert.equal(new DataView(buf).getUint32(0, false), 0x4a565342); // "JVSB"

  const p2 = memPersistence();
  const eng2 = new RagEngine({ embedFn, persistence: p2, dim: DIM });
  const r = await eng2.importBundle('importada', buf);
  assert.deepEqual(r, { name: 'importada', count: 3 });
  const res = await eng2.query('importada', 'un perro grande', 1);
  assert.equal(res[0].id, 'd-perro');
});

test('importBundle rechaza buffer invalido y nombre duplicado', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await assert.rejects(() => eng.importBundle('x', new ArrayBuffer(8)));
  await eng.createCollection('animales', DOCS);
  const buf = await eng.exportBundle('animales');
  await assert.rejects(() => eng.importBundle('animales', buf));
});

test('deleteCollection elimina de persistencia', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', DOCS);
  await eng.deleteCollection('animales');
  assert.deepEqual(await eng.listCollections(), []);
  await assert.rejects(() => eng.query('animales', 'gato', 1));
});

test('addDocuments agrega a una coleccion existente y el doc nuevo es consultable', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', [DOCS[0], DOCS[1]]); // gato, perro
  const r = await eng.addDocuments('animales', [DOCS[2]]);    // + auto
  assert.deepEqual(r, { name: 'animales', added: 1, count: 3 });
  assert.equal((await eng.query('animales', 'auto electrico', 3))[0].id, 'd-auto');
  // y los viejos siguen ahi
  assert.ok((await eng.query('animales', 'gato domestico', 3)).some((h) => h.id === 'd-gato'));
});

test('addDocuments persiste en el bundle: sobrevive a recargar desde persistencia', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', [DOCS[0]]);          // gato
  await eng.addDocuments('animales', [DOCS[1]]);              // + perro
  // engine nuevo, sin cache en memoria: fuerza leer el .jvsb de persistencia
  const eng2 = new RagEngine({ embedFn, persistence: p, dim: DIM });
  assert.ok((await eng2.query('animales', 'perro domestico', 3)).some((h) => h.id === 'd-perro'));
  assert.ok((await eng2.query('animales', 'gato domestico', 3)).some((h) => h.id === 'd-gato'));
});

test('addDocuments rechaza coleccion inexistente', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await assert.rejects(() => eng.addDocuments('nope', [DOCS[0]]), (e) => e.message.includes('no existe'));
});

test('addDocuments rechaza id ya existente sin pisar', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', [DOCS[0]]);
  await assert.rejects(() => eng.addDocuments('animales', [DOCS[0]]), (e) => e.message.includes('ya existe'));
  assert.equal((await eng.query('animales', 'gato', 5)).filter((h) => h.id === 'd-gato').length, 1);
});

test('addDocuments rechaza OKF invalido sin agregar nada', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', [DOCS[0]]);
  const bad = [{ id: 'd-mal', md: '---\ntype: X\ntitle: ab\ndescription: corta\n---\nbody' }];
  await assert.rejects(() => eng.addDocuments('animales', bad), (e) => e.message.includes('d-mal'));
  assert.equal((await eng.query('animales', 'gato', 5)).length, 1);
});

test('updateDocument reemplaza el contenido y el query lo refleja', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', [DOCS[0], DOCS[2]]); // gato, auto
  // d-gato pasa a hablar de perro
  const nuevo = okfDoc('d-gato', 'Ahora perro', 'Un doc que ahora habla del perro domestico.', ['perro']).md;
  const r = await eng.updateDocument('animales', 'd-gato', nuevo);
  assert.deepEqual(r, { name: 'animales', id: 'd-gato', count: 2 });
  const hits = await eng.query('animales', 'perro domestico', 2);
  assert.equal(hits[0].id, 'd-gato');
  assert.equal(hits[0].title, 'Ahora perro');
});

test('updateDocument persiste: sobrevive a recargar desde persistencia', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', [DOCS[0], DOCS[2]]);
  const nuevo = okfDoc('d-gato', 'Editado', 'Descripcion editada mas larga que diez.', ['perro']).md;
  await eng.updateDocument('animales', 'd-gato', nuevo);
  const eng2 = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const hits = await eng2.query('animales', 'perro domestico', 2);
  assert.ok(hits.some((h) => h.id === 'd-gato' && h.title === 'Editado'));
});

test('updateDocument rechaza doc/coleccion inexistente y OKF invalido', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', [DOCS[0]]);
  await assert.rejects(() => eng.updateDocument('animales', 'd-nope', DOCS[1].md), (e) => e.message.includes('no existe'));
  await assert.rejects(() => eng.updateDocument('nope', 'd-gato', DOCS[0].md), (e) => e.message.includes('no existe'));
  await assert.rejects(() => eng.updateDocument('animales', 'd-gato', '---\ntype: X\ntitle: ab\ndescription: corta\n---\nbody'), (e) => e.message.includes('d-gato'));
});

test('removeDocument borra un doc y deja el resto consultable', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', DOCS); // 3
  const r = await eng.removeDocument('animales', 'd-auto');
  assert.deepEqual(r, { name: 'animales', id: 'd-auto', count: 2 });
  assert.ok(!(await eng.query('animales', 'auto', 5)).some((h) => h.id === 'd-auto'));
  assert.ok((await eng.query('animales', 'gato', 5)).some((h) => h.id === 'd-gato'));
});

test('removeDocument persiste: sobrevive a recargar desde persistencia', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', DOCS);
  await eng.removeDocument('animales', 'd-auto');
  const eng2 = new RagEngine({ embedFn, persistence: p, dim: DIM });
  assert.ok(!(await eng2.query('animales', 'auto', 5)).some((h) => h.id === 'd-auto'));
  assert.ok((await eng2.query('animales', 'perro', 5)).some((h) => h.id === 'd-perro'));
});

test('removeDocument rechaza doc inexistente, coleccion inexistente y el ultimo doc', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('animales', [DOCS[0]]); // 1 doc
  await assert.rejects(() => eng.removeDocument('animales', 'd-nope'), (e) => e.message.includes('no existe'));
  await assert.rejects(() => eng.removeDocument('nope', 'd-gato'), (e) => e.message.includes('no existe'));
  await assert.rejects(() => eng.removeDocument('animales', 'd-gato'), (e) => e.message.includes('último'));
});