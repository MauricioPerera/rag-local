import { WebGPUBackend } from 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.22.0/+esm';
import * as tf from 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/+esm';
import { loadLiteRt, loadAndCompile, isWebGPUSupported, getWebGpuDevice } from 'https://cdn.jsdelivr.net/npm/@litertjs/core@2.4.0/+esm';
import { runWithTfjsTensors } from 'https://cdn.jsdelivr.net/npm/@litertjs/tfjs-interop@2.5.0/+esm';
import { PreTrainedTokenizer } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers/+esm';
import { parseOKF, composeEmbeddingText } from './okf.mjs';
import { OKF_DOCS } from './okf-corpus.mjs';

const {
  VectorStore, QuantizedStore, PolarQuantizedStore, IVFIndex, MemoryStorageAdapter, cosineSim,
  idbSaveBundle, idbLoadBundle, idbDeleteBundle,
} = window.JSVectorStore;

const CACHE_DB = 'rag-poc-bundles';
const CACHE_NAME = 'docs-256-int8-v1';

const MODELS_BASE = '../embed-demo/models';
const SEQ_LEN = 256;

const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const runBtn = document.getElementById('runBtn');

function log(msg) {
  console.log(msg);
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function section(title) {
  const h = document.createElement('h3');
  h.className = 'section';
  h.textContent = title;
  resultsEl.appendChild(h);
  return h;
}

function table(headers, rows) {
  const t = document.createElement('table');
  const thead = document.createElement('tr');
  headers.forEach(h => { const th = document.createElement('th'); th.textContent = h; thead.appendChild(th); });
  t.appendChild(thead);
  rows.forEach(r => {
    const tr = document.createElement('tr');
    r.forEach(c => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
    t.appendChild(tr);
  });
  resultsEl.appendChild(t);
  return t;
}

// ── Corpus de prueba (mismo set que test-gemma.js del repo js-vector-store) ──

const documents = [
  { id: 'ia-salud',       text: 'La inteligencia artificial esta revolucionando el diagnostico medico' },
  { id: 'ml-finanzas',    text: 'Machine learning aplicado a la deteccion de fraudes financieros' },
  { id: 'nlp-chatbots',   text: 'Procesamiento de lenguaje natural para chatbots empresariales' },
  { id: 'cv-autonomos',   text: 'Vision por computadora en vehiculos autonomos' },
  { id: 'db-vectoriales', text: 'Bases de datos vectoriales para busqueda semantica' },
  { id: 'cloud-infra',    text: 'Infraestructura cloud para despliegue de modelos de IA' },
  { id: 'robotica',       text: 'Robotica industrial y automatizacion con deep learning' },
  { id: 'rec-systems',    text: 'Sistemas de recomendacion basados en embeddings' },
  { id: 'gen-ai',         text: 'Modelos generativos de texto e imagenes con transformers' },
  { id: 'etica-ia',       text: 'Etica y sesgo en sistemas de inteligencia artificial' },
];

const queries = [
  'inteligencia artificial en medicina',
  'como detectar fraude con machine learning',
  'busqueda semantica con vectores',
  'etica en la inteligencia artificial',
];

// ── Embedding local vía LiteRT.js ──────────────────────────

let model, tokenizer;

async function initEmbedder() {
  log('Cargando runtime LiteRT.js (wasm)...');
  await loadLiteRt('https://cdn.jsdelivr.net/npm/@litertjs/core@2.4.0/wasm/');

  const useWebGPU = await isWebGPUSupported();
  log(`WebGPU disponible: ${useWebGPU}`);
  const accel = useWebGPU ? { accelerator: 'webgpu' } : {};
  if (useWebGPU) {
    const device = await getWebGpuDevice();
    tf.removeBackend('webgpu');
    tf.registerBackend('webgpu', () => new WebGPUBackend(device, device.adapterInfo));
    await tf.setBackend('webgpu');
  }

  log('Cargando embeddinggemma.tflite...');
  model = await loadAndCompile(`${MODELS_BASE}/embeddinggemma.tflite`, accel);

  log('Cargando tokenizer...');
  const tokenizerJSON = await (await fetch(`${MODELS_BASE}/tokenizer.json`)).json();
  const specialTokens = await (await fetch(`${MODELS_BASE}/special_tokens_map.json`)).json();
  tokenizer = new PreTrainedTokenizer(tokenizerJSON, {
    tokenizer_class: 'GemmaTokenizer',
    bos_token: specialTokens.bos_token.content,
    eos_token: specialTokens.eos_token.content,
    pad_token: specialTokens.pad_token.content,
    unk_token: specialTokens.unk_token.content,
    model_max_length: SEQ_LEN,
  });
}

// mode: 'query' | 'document' | 'similarity' (legacy symmetric prompt, kept for the
// existing 768d comparison sections below).
function buildPrompt(text, mode) {
  if (mode === 'query') return `task: search result | query: ${text}`;
  if (mode === 'document') return `title: none | text: ${text}`;
  return `task: sentence similarity | query: ${text}`;
}

function l2normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

// Matryoshka Representation Learning: EmbeddingGemma's dims are trained so a prefix
// truncation is a valid lower-dim embedding on its own — just re-normalize after cutting.
function truncateMRL(vec, dim) {
  return l2normalize(vec.slice(0, dim));
}

async function embed(text, mode = 'similarity') {
  const prompt = buildPrompt(text, mode);
  const ids = tokenizer.encode(prompt, { add_special_tokens: true });
  const padId = tokenizer.convert_tokens_to_ids(tokenizer.pad_token) ?? 0;
  const inputIds = new Int32Array(SEQ_LEN).fill(padId);
  for (let i = 0; i < Math.min(ids.length, SEQ_LEN); i++) inputIds[i] = ids[i];

  const idsTensor = tf.tensor(inputIds, [1, SEQ_LEN], 'int32');
  const outputs = await runWithTfjsTensors(model, [idsTensor]);
  tf.dispose(idsTensor);
  const vec = Array.from(await outputs[0].data());
  tf.dispose(outputs);

  return l2normalize(vec);
}

async function embedBatch(texts, label, mode = 'similarity') {
  const t0 = performance.now();
  const vecs = [];
  for (const t of texts) vecs.push(await embed(t, mode));
  log(`Embebidos ${texts.length} textos (${label}) en ${(performance.now() - t0).toFixed(0)}ms`);
  return vecs;
}

// ── POC principal ──────────────────────────────────────────

async function init() {
  try {
    await initEmbedder();
    statusEl.textContent = 'Modelo listo. Ejecutá el POC.';
    runBtn.disabled = false;
  } catch (e) {
    statusEl.textContent = 'Error cargando modelo: ' + e.message;
    log('ERROR: ' + e.stack);
  }
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  resultsEl.innerHTML = '';
  try {
    const tAll0 = performance.now();

    // 1. Embeber documentos
    statusEl.textContent = 'Generando embeddings de documentos...';
    const docTexts = documents.map(d => d.text);
    const docEmbeddings = await embedBatch(docTexts, 'documentos');
    const dim = docEmbeddings[0].length;
    log(`Dimension de embeddings: ${dim}`);

    // 2. Crear stores e indexar
    statusEl.textContent = 'Indexando en VectorStore (F32) y QuantizedStore (Int8)...';
    const f32Store = new VectorStore(new MemoryStorageAdapter(), dim);
    const q8Store = new QuantizedStore(new MemoryStorageAdapter(), dim);
    const polarStore = new PolarQuantizedStore(new MemoryStorageAdapter(), dim, { bits: 3 });

    const tIndex0 = performance.now();
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const vec = docEmbeddings[i];
      f32Store.set('docs', doc.id, vec, { text: doc.text });
      q8Store.set('docs', doc.id, vec, { text: doc.text });
      polarStore.set('docs', doc.id, vec, { text: doc.text });
    }
    f32Store.flush();
    q8Store.flush();
    polarStore.flush();
    const indexMs = performance.now() - tIndex0;
    const polarBytes = polarStore._bytesPerVec;
    log(`Indexados ${f32Store.count('docs')} docs en los 3 stores en ${indexMs.toFixed(1)}ms`);
    log(`Storage por vector: Float32=${dim * 4}B, Int8=${dim + 8}B, Polar(3bit)=${polarBytes}B`);

    section('1. Carga e indexado');
    table(
      ['Métrica', 'Valor'],
      [
        ['Documentos indexados', String(f32Store.count('docs'))],
        ['Dimensión embedding', String(dim)],
        ['Tiempo indexado (3 stores)', indexMs.toFixed(1) + ' ms'],
        ['Tamaño/vector Float32', dim * 4 + ' bytes'],
        ['Tamaño/vector Int8', dim + 8 + ' bytes (' + (((dim * 4) / (dim + 8))).toFixed(1) + 'x)'],
        ['Tamaño/vector Polar 3-bit', polarBytes + ' bytes (' + ((dim * 4) / polarBytes).toFixed(1) + 'x)'],
      ]
    );

    // 3. Embeber queries
    statusEl.textContent = 'Generando embeddings de queries...';
    const queryEmbeddings = await embedBatch(queries, 'queries');

    // 4. Recuperación Float32 vs Int8 vs Polar, lado a lado
    statusEl.textContent = 'Ejecutando búsquedas...';
    section('2. Recuperación (top-3) — Float32 vs Int8 vs Polar 3-bit');
    for (let q = 0; q < queries.length; q++) {
      const f32Results = f32Store.search('docs', queryEmbeddings[q], 3);
      const q8Results = q8Store.search('docs', queryEmbeddings[q], 3);
      const polarResults = polarStore.search('docs', queryEmbeddings[q], 3);
      const h = document.createElement('p');
      h.innerHTML = `<b>Query:</b> "${queries[q]}"`;
      resultsEl.appendChild(h);
      table(
        ['#', 'Float32: id (score)', 'Int8: id (score)', 'Polar: id (score)'],
        f32Results.map((r, i) => [
          String(i + 1),
          `${r.id} (${r.score.toFixed(4)})`,
          q8Results[i] ? `${q8Results[i].id} (${q8Results[i].score.toFixed(4)})` : '—',
          polarResults[i] ? `${polarResults[i].id} (${polarResults[i].score.toFixed(4)})` : '—',
        ])
      );
    }

    // 5. Comparación de precisión (orden top-5 idéntico entre los 3 stores)
    section('3. Precisión: ¿coincide el orden top-5 con Float32?');
    const precisionRows = [];
    for (let q = 0; q < queries.length; q++) {
      const f32Order = f32Store.search('docs', queryEmbeddings[q], 5).map(r => r.id);
      const q8Order = q8Store.search('docs', queryEmbeddings[q], 5).map(r => r.id);
      const polarOrder = polarStore.search('docs', queryEmbeddings[q], 5).map(r => r.id);
      const q8Match = f32Order.every((id, i) => id === q8Order[i]);
      const polarMatch = f32Order.every((id, i) => id === polarOrder[i]);
      precisionRows.push([
        queries[q],
        q8Match ? 'IDÉNTICO' : `DIFERENTE (${q8Order.join(', ')})`,
        polarMatch ? 'IDÉNTICO' : `DIFERENTE (${polarOrder.join(', ')})`,
      ]);
    }
    table(['Query', 'Int8 vs F32', 'Polar 3-bit vs F32'], precisionRows);

    // 6. IVF Index sobre QuantizedStore
    statusEl.textContent = 'Construyendo índice IVF...';
    section('4. IVF Index (sobre QuantizedStore)');
    const ivf = new IVFIndex(q8Store, 3, 2);
    const stats = ivf.build('docs');
    log(`IVF: ${stats.numClusters} clusters, ${stats.numVectors} vectores`);
    const ivfResults = ivf.search('docs', queryEmbeddings[0], 3);
    table(
      ['Métrica', 'Valor'],
      [['Clusters', String(stats.numClusters)], ['Vectores', String(stats.numVectors)]]
    );
    const ivfP = document.createElement('p');
    ivfP.innerHTML = `<b>IVF search para:</b> "${queries[0]}"`;
    resultsEl.appendChild(ivfP);
    table(['#', 'id', 'score', 'texto'], ivfResults.map((r, i) => [String(i + 1), r.id, r.score.toFixed(4), r.metadata.text]));

    // 7. Matriz de similitud cruzada (primeros 5 docs)
    section('5. Matriz de similitud (primeros 5 documentos)');
    const headers = ['', ...documents.slice(0, 5).map(d => d.id)];
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const row = [documents[i].id];
      for (let j = 0; j < 5; j++) row.push(cosineSim(docEmbeddings[i], docEmbeddings[j]).toFixed(4));
      rows.push(row);
    }
    table(headers, rows);

    // 8. Pipeline optimizado: prompts asimétricos + MRL 256d + Int8 + caché IndexedDB
    section('6. Pipeline optimizado (prompts asimétricos + MRL 256d + Int8 + caché IndexedDB)');
    const OPT_DIM = 256;
    let opt8Store, fromCache, buildMs;

    statusEl.textContent = 'Buscando índice en IndexedDB...';
    const tCache0 = performance.now();
    const cached = await idbLoadBundle(CACHE_NAME, CACHE_DB);
    if (cached) {
      const adapter = MemoryStorageAdapter.fromBundle(cached);
      opt8Store = new QuantizedStore(adapter, OPT_DIM);
      fromCache = true;
      buildMs = performance.now() - tCache0;
      log(`Índice optimizado cargado desde IndexedDB en ${buildMs.toFixed(1)}ms (0 llamadas al modelo)`);
    } else {
      const tBuild0 = performance.now();
      const docEmbeddingsDoc = await embedBatch(docTexts, 'documentos, prompt asimétrico', 'document');
      const docEmbeddingsMRL = docEmbeddingsDoc.map(v => truncateMRL(v, OPT_DIM));
      opt8Store = new QuantizedStore(new MemoryStorageAdapter(), OPT_DIM);
      for (let i = 0; i < documents.length; i++) {
        opt8Store.set('docs', documents[i].id, docEmbeddingsMRL[i], { text: documents[i].text });
      }
      opt8Store.flush();
      await idbSaveBundle(CACHE_NAME, opt8Store._adapter.toBundle(), CACHE_DB);
      fromCache = false;
      buildMs = performance.now() - tBuild0;
      log(`Índice optimizado construido y guardado en IndexedDB en ${buildMs.toFixed(1)}ms`);
    }

    const optBytes = OPT_DIM + 8;
    table(
      ['Métrica', 'Valor'],
      [
        ['Origen de este run', fromCache ? 'IndexedDB (caché)' : 'Recalculado + guardado'],
        ['Tiempo de carga/construcción', buildMs.toFixed(1) + ' ms'],
        ['Dimensión (MRL truncado 768→256)', String(OPT_DIM)],
        ['Tamaño/vector (256d Int8)', optBytes + ' bytes (' + ((768 * 4) / optBytes).toFixed(1) + 'x vs Float32 768d)'],
      ]
    );

    const queryEmbeddingsOpt = await embedBatch(queries, 'queries, prompt asimétrico', 'query');
    const queryEmbeddingsOptMRL = queryEmbeddingsOpt.map(v => truncateMRL(v, OPT_DIM));

    for (let q = 0; q < queries.length; q++) {
      const results = opt8Store.search('docs', queryEmbeddingsOptMRL[q], 3);
      const h = document.createElement('p');
      h.innerHTML = `<b>Query:</b> "${queries[q]}"`;
      resultsEl.appendChild(h);
      table(
        ['#', 'id', 'score', 'texto'],
        results.map((r, i) => [String(i + 1), r.id, r.score.toFixed(4), r.metadata.text])
      );
    }

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Limpiar caché IndexedDB (forzar recálculo)';
    clearBtn.onclick = async () => {
      await idbDeleteBundle(CACHE_NAME, CACHE_DB);
      alert('Caché borrado. Volvé a ejecutar el POC para ver el recálculo desde cero.');
    };
    resultsEl.appendChild(clearBtn);

    // 9. Bundle portable: exportar el índice como archivo .jvsb e importarlo de vuelta
    section('7. Archivo portable (.jvsb) — exportar / importar el índice');
    const bundleBuf = opt8Store._adapter.toBundle();
    table(
      ['Métrica', 'Valor'],
      [
        ['Tamaño del archivo', (bundleBuf.byteLength / 1024).toFixed(1) + ' KB'],
        ['Contenido', `colección "docs": ${opt8Store.count('docs')} vectores Int8 256d + metadata (textos)`],
        ['Formato', 'JVSB v1 (binario zero-dep de js-vector-store)'],
      ]
    );

    const dlBtn = document.createElement('button');
    dlBtn.textContent = 'Descargar índice (.jvsb)';
    dlBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bundleBuf], { type: 'application/octet-stream' }));
      a.download = 'rag-index-docs-256d-int8.jvsb';
      a.click();
    };
    resultsEl.appendChild(dlBtn);

    const importLabel = document.createElement('p');
    importLabel.innerHTML = '<b>Importar un .jvsb</b> (reconstruye el store desde el archivo y ejecuta la query 1 como verificación):';
    resultsEl.appendChild(importLabel);
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.jvsb';
    importInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const t0 = performance.now();
      const buf = await file.arrayBuffer();
      const importedStore = new QuantizedStore(MemoryStorageAdapter.fromBundle(buf), OPT_DIM);
      const results = importedStore.search('docs', queryEmbeddingsOptMRL[0], 3);
      const ms = (performance.now() - t0).toFixed(1);
      const p = document.createElement('p');
      p.innerHTML = `<b>Importado "${file.name}"</b> (${(buf.byteLength / 1024).toFixed(1)} KB) en ${ms}ms — ` +
        `${importedStore.count('docs')} vectores. Query "${queries[0]}" → top-1: <b>${results[0]?.id}</b> (${results[0]?.score.toFixed(4)})`;
      resultsEl.appendChild(p);
      log(`Bundle importado desde archivo en ${ms}ms, búsqueda OK: ${results[0]?.id}`);
    };
    resultsEl.appendChild(importInput);

    // 10. A/B — texto crudo vs texto OKF (una sola variable: el texto embebido del doc)
    section('8. A/B — texto crudo vs texto OKF');
    const AB_DIM = dim; // 768
    const rawStore = new QuantizedStore(new MemoryStorageAdapter(), AB_DIM);
    const okfStore = new QuantizedStore(new MemoryStorageAdapter(), AB_DIM);

    const okfTexts = OKF_DOCS.map(d => composeEmbeddingText(parseOKF(d.md)));
    const rawEmbeddings = await embedBatch(docTexts, 'A/B crudo, prompt asimétrico', 'document');
    const okfEmbeddings = await embedBatch(okfTexts, 'A/B OKF, prompt asimétrico', 'document');

    for (let i = 0; i < documents.length; i++) {
      rawStore.set('docs', documents[i].id, rawEmbeddings[i], { text: documents[i].text });
      okfStore.set('docs', OKF_DOCS[i].id, okfEmbeddings[i], { text: okfTexts[i] });
    }
    rawStore.flush();
    okfStore.flush();

    // Queries: set compartido 768d, mode 'query'. Reuso queryEmbeddingsOpt (definido en
    // la sección 6, embebido con mode 'query', 768d SIN truncar — queryEmbeddingsOptMRL
    // es la versión truncada a 256 que uso solo el store optimizado, no acá).
    const abQueryEmbeddings = queryEmbeddingsOpt;

    const summaryRows = [];
    let deltaSum = 0;
    for (let q = 0; q < queries.length; q++) {
      const rawResults = rawStore.search('docs', abQueryEmbeddings[q], 3);
      const okfResults = okfStore.search('docs', abQueryEmbeddings[q], 3);

      const qh = document.createElement('p');
      qh.innerHTML = `<b>Query:</b> "${queries[q]}"`;
      resultsEl.appendChild(qh);
      table(
        ['#', 'Crudo: id (score)', 'OKF: id (score)'],
        rawResults.map((r, i) => [
          String(i + 1),
          `${r.id} (${r.score.toFixed(4)})`,
          okfResults[i] ? `${okfResults[i].id} (${okfResults[i].score.toFixed(4)})` : '—',
        ])
      );

      const rawMargin = rawResults[0].score - rawResults[1].score;
      const okfMargin = okfResults[0].score - okfResults[1].score;
      const delta = okfMargin - rawMargin;
      deltaSum += delta;
      summaryRows.push([
        queries[q],
        `${rawResults[0].id} (${rawResults[0].score.toFixed(4)})`,
        `${okfResults[0].id} (${okfResults[0].score.toFixed(4)})`,
        rawMargin.toFixed(4),
        okfMargin.toFixed(4),
        delta.toFixed(4),
      ]);
    }
    table(
      ['query', 'top1 crudo (score)', 'top1 OKF (score)', 'margen crudo (top1-top2)', 'margen OKF (top1-top2)', 'delta margen (OKF - crudo)'],
      summaryRows
    );
    const avgDelta = deltaSum / queries.length;
    log(`Delta de margen promedio (OKF - crudo): ${avgDelta.toFixed(4)}`);

    const totalMs = performance.now() - tAll0;
    statusEl.textContent = `POC completo en ${totalMs.toFixed(0)}ms.`;
    log(`\nPOC completo en ${totalMs.toFixed(0)}ms total.`);
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    log('ERROR: ' + e.stack);
  } finally {
    runBtn.disabled = false;
  }
});

init();
