import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RagEngine, RELATIVE_PATTERNS } from './rag-engine.mjs';
import { parseMarkdownLinks, isConceptTarget } from './okf.mjs';

const DIM = 8;
function fakeEmbed(text) {
  const v = new Array(DIM).fill(0.01);
  if (text.includes('gato')) v[0] = 1;
  else if (text.includes('perro')) v[1] = 1;
  else if (text.includes('auto')) v[2] = 1;
  else if (text.includes('storm')) v[3] = 1;
  else v[4] = 1;
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

// Helper de doc OKF con body arbitrario (para meter links markdown).
const doc = (id, title, desc, tags, body) => ({
  id,
  md: `---\ntype: Nota\ntitle: ${title}\ndescription: ${desc}\ntags: [${tags.join(', ')}]\n---\n\n${body}`,
});

const BASE = (id, title, desc, tags, body = desc) => doc(id, title, desc, tags, body);

// ─── RELATIVE_PATTERNS (constante exportada, testeable) ───────────────────────

test('RELATIVE_PATTERNS exportado y matchea las referencias relativas builtin', () => {
  assert.ok(Array.isArray(RELATIVE_PATTERNS));
  assert.ok(RELATIVE_PATTERNS.length >= 4);
  const text = (s) => RELATIVE_PATTERNS.some((re) => re.test(s));
  assert.ok(text('the port immediately after the gateway'));
  assert.ok(text('the next section covers'));
  assert.ok(text('the same row'));
  assert.ok(text('3 days before launch'));
  assert.ok(text('a day after'));
  assert.ok(text('higher than the ceiling'));
  assert.ok(text('lower than the floor'));
  assert.ok(!text('el gato duerme plácidamente en su casa'));
});

// ─── parseMarkdownLinks / isConceptTarget (helpers expuestos) ────────────────

test('parseMarkdownLinks extrae targets y isConceptTarget filtra URLs', () => {
  const links = parseMarkdownLinks('ve [el gato](d-gato) y [docs](https://x.com) y [nada]()');
  assert.deepEqual(links.map((l) => l.target), ['d-gato', 'https://x.com']);
  assert.ok(isConceptTarget('d-gato'));
  assert.ok(!isConceptTarget('https://x.com'));
  assert.ok(!isConceptTarget('mailto:a@b.com'));
  assert.ok(!isConceptTarget(''));
});

// ─── Contrato válido: crea, persiste, sobrevive a recarga ─────────────────────

test('createCollection con contrato válido persiste y sobrevive a recarga', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const contract = { max_chars: 80, allowed_tags: ['gato', 'perro', 'animales'], min_links: 0 };
  const r = await eng.createCollection('animales', [
    BASE('d-gato', 'El gato', 'Un documento que habla del gato domestico.', ['gato', 'animales']),
    BASE('d-perro', 'El perro', 'Un documento que habla del perro domestico.', ['perro', 'animales']),
  ], contract);
  assert.equal(r.count, 2);

  // Recarga: engine nuevo, sin cache → el contrato debe seguir embebido en el bundle.
  const eng2 = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const got = await eng2._loadContract('animales');
  assert.deepEqual(got, contract);

  // addDocuments re-aplica el contrato: tag fuera de allowed_tags → rechazo.
  await assert.rejects(
    () => eng2.addDocuments('animales', [BASE('d-auto', 'El auto', 'Un documento que habla del auto electrico.', ['auto', 'vehiculos'])]),
    (e) => e.message.includes('kc-tags') && e.message.includes('auto'),
  );
  // y agrega uno válido (tag permitido).
  const r2 = await eng2.addDocuments('animales', [BASE('d-pez', 'El pez', 'Un documento que habla del pez del mar.', ['animales'])]);
  assert.equal(r2.count, 3);
});

// ─── kc-max-chars ─────────────────────────────────────────────────────────────

test('kc-max-chars: description que excede el tope es rechazada con nombre de regla', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const longDesc = 'X'.repeat(120);
  const bad = BASE('d-gato', 'El gato', longDesc, ['gato']);
  await assert.rejects(
    () => eng.createCollection('c', [bad], { max_chars: 50 }),
    (e) => e.message.includes('kc-max-chars') && e.message.includes('d-gato'),
  );
  assert.deepEqual(await eng.listCollections(), []); // no persiste
});

test('kc-max-chars: 0/ausente = sin tope (no rechaza descriptions largas)', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const longDesc = 'X'.repeat(500);
  const r = await eng.createCollection('c', [BASE('d', 'El doc', longDesc, ['t'])], { max_chars: 0 });
  assert.equal(r.count, 1);
});

// ─── kc-relative ──────────────────────────────────────────────────────────────

test('kc-relative: forbid_relative rechaza referencias relativas builtin', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const bad = BASE('d', 'El puerto', 'El puerto inmediatamente despues del gateway principal.', ['geo'], 'the port immediately after the gateway');
  await assert.rejects(
    () => eng.createCollection('c', [bad], { forbid_relative: true }),
    (e) => e.message.includes('kc-relative') && e.message.includes('d'),
  );
});

test('kc-relative: sin forbid_relative la misma frase pasa (opt-in)', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const ok = BASE('d', 'El puerto', 'El puerto inmediatamente despues del gateway principal.', ['geo'], 'the port immediately after the gateway');
  const r = await eng.createCollection('c', [ok]); // sin contrato
  assert.equal(r.count, 1);
});

// ─── kc-forbidden (patrones custom) ───────────────────────────────────────────

test('kc-forbidden: forbidden_patterns custom matchea y rechaza', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const bad = BASE('d', 'Storm db', 'La stormdb se conecta a vega y sube a R2.', ['infra']);
  await assert.rejects(
    () => eng.createCollection('c', [bad], { forbidden_patterns: ['\\bstormdb\\b', '\\bvega\\b'] }),
    (e) => e.message.includes('kc-forbidden'),
  );
});

test('contrato invalido (regex roto) → rechazo total con mensaje claro', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await assert.rejects(
    () => eng.createCollection('c', [BASE('d', 'El doc', 'Descripcion suficientemente larga.', ['t'])], { forbidden_patterns: ['(['] }),
    (e) => e.message.includes('contrato inválido'),
  );
  assert.deepEqual(await eng.listCollections(), []);
});

test('contrato invalido (max_chars no número) → rechazo total', async () => {
  const eng = new RagEngine({ embedFn, persistence: memPersistence(), dim: DIM });
  await assert.rejects(
    () => eng.createCollection('c', [BASE('d', 'El doc', 'Descripcion suficientemente larga.', ['t'])], { max_chars: 'big' }),
  );
});

// ─── kc-tags ──────────────────────────────────────────────────────────────────

test('kc-tags: tag fuera de allowed_tags es rechazado', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const bad = BASE('d', 'El auto', 'Un documento que habla del auto electrico.', ['auto', 'vehiculos']);
  await assert.rejects(
    () => eng.createCollection('c', [bad], { allowed_tags: ['gato', 'perro'] }),
    (e) => e.message.includes('kc-tags') && e.message.includes('vehiculos'),
  );
});

// ─── kc-links ─────────────────────────────────────────────────────────────────

test('kc-links: min_links exige links markdown internos en el body', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  // body sin links → viola min_links=1
  const noLinks = BASE('d-a', 'Nodo A', 'Descripcion del nodo A independientemente.', ['t'], 'Texto plano sin vinculos.');
  await assert.rejects(
    () => eng.createCollection('c', [noLinks], { min_links: 1 }),
    (e) => e.message.includes('kc-links') && e.message.includes('d-a'),
  );

  // body con un link interno a un concept-id → pasa
  const withLinks = BASE('d-a', 'Nodo A', 'Descripcion del nodo A independientemente.', ['t'], 'Vinculado a [el B](d-b).');
  const r = await eng.createCollection('c', [withLinks], { min_links: 1 });
  assert.equal(r.count, 1);
});

test('kc-links: URLs externas no cuentan como links internos', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const onlyUrl = BASE('d', 'Nodo', 'Descripcion del nodo con url externa nada mas.', ['t'], 'Ver [docs](https://example.com).');
  await assert.rejects(
    () => eng.createCollection('c', [onlyUrl], { min_links: 1 }),
    (e) => e.message.includes('kc-links'),
  );
});

// ─── Expansión de links en query ──────────────────────────────────────────────

// Cadena: stormdb → vega → R2. Los bodies declaran links a ids hermanos.
const CHAIN = [
  doc('stormdb', 'Storm DB', 'La base de datos temporal del pipeline de storm.', ['infra'],
    'Storm persiste en [vega](vega).'),
  doc('vega', 'Vega', 'El nodo de procesamiento intermedio del pipeline.', ['infra'],
    'Vega sube los resultados a [R2](r2).'),
  doc('r2', 'R2 Storage', 'El almacenamiento final de objetos en Quito.', ['infra'],
    'R2 guarda los objetos del pipeline de storm.'),
];

test('query sin expand_links = comportamiento idéntico (solo top-k normales)', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('chain', CHAIN);
  const res = await eng.query('chain', 'donde esta la storm db', 1);
  assert.equal(res.length, 1);
  assert.equal(res[0].id, 'stormdb');
  assert.equal(res[0].expanded, undefined);
  assert.equal(res[0].via, undefined);
  assert.ok(typeof res[0].score === 'number');
});

test('query con expand_links agrega el doc linkeado (1 salto, score:null, via)', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('chain', CHAIN);
  const res = await eng.query('chain', 'donde esta la storm db', 1, { expand_links: true });
  // hit normal primero, expandidos después
  assert.equal(res[0].id, 'stormdb');
  assert.equal(res[0].expanded, undefined);
  // stormdb → vega (link existente)
  const exp = res.find((h) => h.id === 'vega');
  assert.ok(exp, 'vega debe aparecer como expandido');
  assert.equal(exp.expanded, true);
  assert.equal(exp.via, 'stormdb');
  assert.equal(exp.score, null);
  // sin recursión: vega→r2 NO se expande desde este hit
  assert.ok(!res.some((h) => h.id === 'r2'), 'no debe expandir 2 saltos (r2)');
});

test('expand_links: links a ids inexistentes se ignoran', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  const docs = [
    doc('a', 'Nodo A', 'Descripcion del nodo A del grafo de prueba.', ['t'],
      'Apunta a [B existente](b) y a [fantasma](no-existe).'),
    doc('b', 'Nodo B', 'Descripcion del nodo B del grafo de prueba.', ['t'], 'Nodo terminal.'),
  ];
  await eng.createCollection('g', docs);
  const res = await eng.query('g', 'nodo a', 1, { expand_links: true });
  assert.equal(res[0].id, 'a');
  assert.ok(res.some((h) => h.id === 'b' && h.via === 'a'));
  assert.ok(!res.some((h) => h.id === 'no-existe'));
});

test('expand_links: no duplica hits ya presentes ni repite expandidos', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  // b aparece como hit normal (top-2) Y está linkeado desde a → no debe duplicarse.
  const docs = [
    doc('a', 'Nodo A', 'Descripcion del nodo A del grafo de prueba.', ['t'],
      'Vinculo a [B](b).'),
    doc('b', 'Nodo B', 'Descripcion del nodo B del grafo de prueba.', ['t'], 'Terminal.'),
    doc('c', 'Nodo C', 'Descripcion del nodo C del grafo de prueba.', ['t'], 'Vinculo a [B](b) tambien.'),
  ];
  await eng.createCollection('g', docs);
  const res = await eng.query('g', 'nodo a nodo b', 2, { expand_links: true });
  const bHits = res.filter((h) => h.id === 'b');
  assert.equal(bHits.length, 1, 'b debe aparecer una sola vez (sin duplicados)');
});

// Reproduce exactamente el bug reportado por el PM contra el server real:
// dos hits DISTINCTOS linkeando al mismo doc → sin dedup aparecía DUPLICADO
// ([a, c, b(expanded), b(expanded)]). Debe aparecer una sola vez, expandido,
// con via = el primer hit (en orden de resultado) que lo linkeó, y jamás si
// ya está entre los hits normales.
test('expand_links: dos hits que linkean al mismo doc lo expanden una sola vez (via = primer hit)', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  // 'gato' aparece en a y c (no en b) → el query 'gato' tiene como top-2 a {a, c};
  // b queda fuera de los hits normales y solo entra por expansión.
  const docs = [
    doc('a', 'Nodo A', 'Descripcion del nodo A del grafo de gato.', ['t'],
      'Linkea a [vega](b).'),
    doc('c', 'Nodo C', 'Descripcion del nodo C del grafo de gato.', ['t'],
      'b linkeado tambien desde [c](b).'),
    doc('b', 'Nodo B', 'Descripcion del nodo B terminal del grafo.', ['t'], 'Terminal.'),
  ];
  await eng.createCollection('g', docs);
  const res = await eng.query('g', 'gato', 2, { expand_links: true });

  // Hits normales = exactamente a y c (b no es hit normal).
  const hitIds = res.filter((h) => h.expanded !== true).map((h) => h.id);
  assert.deepEqual([...hitIds].sort(), ['a', 'c'], 'los hits normales son a y c (b no es hit)');

  // b expandido una sola vez aunque dos hits lo linkean (sin dedup sería 2).
  const bHits = res.filter((h) => h.id === 'b');
  assert.equal(bHits.length, 1, 'b debe aparecer una sola vez aunque dos hits la linkeen');
  const b = bHits[0];
  assert.equal(b.expanded, true);
  assert.equal(b.score, null);

  // via = el primer hit (en orden de resultado) cuyo body linkea a b.
  const firstLinker = res.find((h) => h.expanded !== true && (h.md || '').includes('](b)'));
  assert.ok(firstLinker, 'debe haber un hit normal que linkee a b');
  assert.equal(b.via, firstLinker.id, 'via debe ser el primer hit que linkeo a b');
});

// Reproduce el bug residual intra-hit diagnosticado por el PM: el MISMO doc
// contiene el mismo link DOS veces en su md (en la `description:` del
// frontmatter Y en el body — caso real con [vega](b)). Sin dedup intra-hit,
// `targets` sale [b, b] porque el filter con `!seen.has(t)` se evalúa de una
// vez ANTES del loop interno, y el loop agrega ambos. b debe expanderse UNA
// sola vez aunque aparezca dos veces en el mismo hit.
test('expand_links: link repetido en description Y body del mismo hit se expande una sola vez', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  // a tiene el link [vega](b) tanto en la description del frontmatter como en
  // el body → parseMarkdownLinks extrae b dos veces del md del mismo hit.
  const docs = [
    doc('a', 'Nodo A', 'Descripcion del nodo A que vincula a [vega](b).', ['t'],
      'Body del nodo A que tambien vincula a [vega](b).'),
    doc('b', 'Nodo B', 'Descripcion del nodo B terminal del grafo.', ['t'], 'Terminal.'),
  ];
  await eng.createCollection('g', docs);
  const res = await eng.query('g', 'nodo a', 1, { expand_links: true });

  assert.equal(res[0].id, 'a');
  const bHits = res.filter((h) => h.id === 'b');
  assert.equal(bHits.length, 1, 'b debe aparecer una sola vez aunque el mismo hit la linkee dos veces');
  assert.equal(bHits[0].expanded, true);
  assert.equal(bHits[0].via, 'a');
  assert.equal(bHits[0].score, null);
});

test('expand_links sobre colección sin contrato funciona igual', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn, persistence: p, dim: DIM });
  await eng.createCollection('chain', CHAIN, { allowed_tags: ['infra'] });
  const res = await eng.query('chain', 'storm db', 1, { expand_links: true });
  assert.ok(res.some((h) => h.id === 'vega' && h.expanded === true));
});

// ─── threshold + hops (GAP 1 y GAP 2) ─────────────────────────────────────────
//
// embedFn controlado: el query va al ángulo 0 (vector (1,0,0...)), y cada doc
// embebe un vector unitario (cos θ, sin θ, 0...) donde cos θ es el score exacto
// que queremos contra el query. El marker `sNNN` en la description fija ese
// cosine = NNN/1000. Así reproducimos los scores reales del bug (f5=0.71,
// f6=0.335) de forma determinista y testeable sin tocar el server.

function controlledEmbed(text, mode) {
  if (mode === 'query') {
    const v = new Array(DIM).fill(0);
    v[0] = 1;
    return v;
  }
  const m = /s(\d{3})/.exec(String(text));
  const cos = m ? Number(m[1]) / 1000 : 0;
  const v = new Array(DIM).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}
const controlledEmbedFn = async (text, mode) => controlledEmbed(text, mode);

// Cadena lineal de 5 eslabones para tests de hops y clampeo: n0→n1→n2→n3→n4.
// n0 es el único hit relevante; el resto entra sólo por expansión.
const SCORED = (id, score, body) => doc(
  id,
  `Nodo ${id}`,
  `Nodo ${id} con score controlado s${String(Math.round(score * 1000)).padStart(3, '0')} descriptivo.`,
  ['t'],
  body,
);

const CHAIN5 = [
  SCORED('n0', 0.90, 'Apunta a [n1](n1).'),
  SCORED('n1', 0.10, 'Apunta a [n2](n2).'),
  SCORED('n2', 0.10, 'Apunta a [n3](n3).'),
  SCORED('n3', 0.10, 'Apunta a [n4](n4).'),
  SCORED('n4', 0.10, 'Nodo terminal del chain.'),
];

async function makeChain5() {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn: controlledEmbedFn, persistence: p, dim: DIM });
  await eng.createCollection('chain5', CHAIN5);
  return eng;
}

test('threshold filtra los hits normales por score >= umbral (sin expandir)', async () => {
  const eng = await makeChain5();
  // k=3 trae n0(0.90), n1(0.10), n2(0.10). threshold 0.5 → sólo n0 sobrevive.
  const res = await eng.query('chain5', 'q', 3, { threshold: 0.5 });
  const hitIds = res.filter((h) => h.expanded !== true).map((h) => h.id);
  assert.deepEqual(hitIds, ['n0']);
  assert.equal(res.length, 1);
  assert.ok(typeof res[0].score === 'number' && res[0].score >= 0.5);
});

test('GAP 1: doc sub-umbral entre los k crudos es rescatado vía link con threshold', async () => {
  // Reproduce el caso exacto: f5(0.71) linkea a f6; f6 está entre los k crudos
  // con 0.335; umbral 0.35 → f6 descartado como hit normal; el engine expande
  // desde los sobrevivientes (sólo f5) y rescata f6 por link (no está en `seen`).
  const p = memPersistence();
  const eng = new RagEngine({ embedFn: controlledEmbedFn, persistence: p, dim: DIM });
  await eng.createCollection('gap1', [
    SCORED('f5', 0.71, 'Linkea a [f6](f6).'),
    SCORED('f6', 0.335, 'Nodo f6 sub-umbral pero linkeado desde f5.'),
    SCORED('f7', 0.10, 'Nodo f7 no linkeado desde f5.'),
  ]);

  // Sin threshold (bug): f6 es hit normal con 0.335 y el cliente lo descarta
  // después → se pierde. Acá mostramos la grieta: f6 queda como hit normal crudo.
  const raw = await eng.query('gap1', 'q', 3, { expand_links: true });
  const rawF6 = raw.find((h) => h.id === 'f6');
  assert.ok(rawF6 && rawF6.expanded !== true, 'sin threshold f6 es hit normal crudo (la grieta)');
  assert.ok(typeof rawF6.score === 'number' && rawF6.score < 0.35);

  // Con threshold 0.35 + expansión: f6 se descarta como hit normal PERO el
  // engine lo rescata vía el link de f5, con score:null y via f5.
  const res = await eng.query('gap1', 'q', 3, { expand_links: true, threshold: 0.35 });
  const hitIds = res.filter((h) => h.expanded !== true).map((h) => h.id);
  assert.deepEqual(hitIds, ['f5'], 'sólo f5 sobrevive el umbral como hit normal');

  const f6 = res.find((h) => h.id === 'f6');
  assert.ok(f6, 'f6 debe ser rescatado vía link (no perdido en la grieta)');
  assert.equal(f6.expanded, true);
  assert.equal(f6.via, 'f5');
  assert.equal(f6.score, null);

  // f7 no está linkeado desde f5 → no entra (y con 1 salto tampoco llegaría).
  assert.ok(!res.some((h) => h.id === 'f7'));
});

test('hops=2 alcanza el tercer eslabón de la cadena (n0→n1→n2)', async () => {
  const eng = await makeChain5();
  const res = await eng.query('chain5', 'q', 1, { expand_links: true, hops: 2 });
  assert.equal(res[0].id, 'n0');
  const n1 = res.find((h) => h.id === 'n1');
  const n2 = res.find((h) => h.id === 'n2');
  assert.ok(n1 && n1.expanded === true && n1.via === 'n0', 'n1 expandido en salto 1 via n0');
  assert.ok(n2 && n2.expanded === true && n2.via === 'n1', 'n2 expandido en salto 2 via n1');
  assert.equal(n2.score, null);
  // n3 requiere un 3er salto → ausente con hops=2.
  assert.ok(!res.some((h) => h.id === 'n3'));
});

test('hops=1 (default) no pasa del primer salto aunque la cadena continúe', async () => {
  const eng = await makeChain5();
  const res = await eng.query('chain5', 'q', 1, { expand_links: true }); // hops default 1
  assert.ok(res.some((h) => h.id === 'n1' && h.via === 'n0'));
  assert.ok(!res.some((h) => h.id === 'n2'));
});

test('links circulares a→b→a terminan y no duplican (dedup global)', async () => {
  const p = memPersistence();
  const eng = new RagEngine({ embedFn: controlledEmbedFn, persistence: p, dim: DIM });
  await eng.createCollection('circ', [
    SCORED('a', 0.90, 'Apunta a [b](b).'),
    SCORED('b', 0.10, 'Apunta de vuelta a [a](a).'),
  ]);
  // hops=3 (tope): sin dedup global el a→b→a→b... entraría en loop. Debe terminar.
  const res = await eng.query('circ', 'q', 1, { expand_links: true, hops: 3 });
  const aHits = res.filter((h) => h.id === 'a');
  const bHits = res.filter((h) => h.id === 'b');
  assert.equal(aHits.length, 1, 'a aparece una sola vez (hit normal, no re-agregado)');
  assert.equal(aHits[0].expanded, undefined);
  assert.equal(bHits.length, 1, 'b aparece una sola vez (expandido, no duplicado por el ciclo)');
  assert.equal(bHits[0].expanded, true);
  assert.equal(bHits[0].via, 'a');
});

test('hops>3 se clampea a 3 (tope duro): no alcanza el 5to eslabón', async () => {
  const eng = await makeChain5();
  // hops=3 alcanza n1,n2,n3 (3 saltos). n4 requeriría un 4to salto.
  const res3 = await eng.query('chain5', 'q', 1, { expand_links: true, hops: 3 });
  assert.ok(res3.some((h) => h.id === 'n3' && h.via === 'n2'), 'con hops=3 llega a n3');
  assert.ok(!res3.some((h) => h.id === 'n4'), 'con hops=3 NO llega a n4');

  // hops=10 debe clampearse a 3 → mismo alcance que hops=3 (n4 ausente).
  const res10 = await eng.query('chain5', 'q', 1, { expand_links: true, hops: 10 });
  assert.ok(res10.some((h) => h.id === 'n3'), 'con hops=10 (=3) llega a n3');
  assert.ok(!res10.some((h) => h.id === 'n4'), 'con hops=10 clampeado NO llega a n4');

  // y hops=4 también clampea a 3.
  const res4 = await eng.query('chain5', 'q', 1, { expand_links: true, hops: 4 });
  assert.ok(!res4.some((h) => h.id === 'n4'));
});

test('ausencia de threshold y hops = resultados byte-idénticos al comportamiento previo', async () => {
  const eng = await makeChain5();
  // query sin options, con {} y con {expand_links:false} deben devolver exacto
  // los mismos top-k normales (mismos ids, scores numéricos, sin expanded/via).
  const noOpts = await eng.query('chain5', 'q', 3);
  const emptyOpts = await eng.query('chain5', 'q', 3, {});
  const noExpand = await eng.query('chain5', 'q', 3, { expand_links: false });

  assert.deepEqual(noOpts, emptyOpts);
  assert.deepEqual(noOpts, noExpand);

  // Shape previo: scores numéricos, sin campos expanded/via, orden por score desc.
  assert.deepEqual(noOpts.map((h) => h.id), ['n0', 'n1', 'n2']);
  for (const h of noOpts) {
    assert.equal(h.expanded, undefined);
    assert.equal(h.via, undefined);
    assert.ok(typeof h.score === 'number');
  }
  // orden desc por score
  assert.ok(noOpts[0].score >= noOpts[1].score && noOpts[1].score >= noOpts[2].score);
});