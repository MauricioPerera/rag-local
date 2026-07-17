// app.js — cablea el engine de rag-poc en el navegador.
//
// No reimplementa nada: RagEngine, okf y js-vector-store son los mismos archivos
// que usa rag-server.mjs. Acá solo se inyectan las dos dependencias que cambian
// entre Node y navegador:
//   persistence -> fsaPersistence(carpeta elegida por el usuario)   [File System Access]
//   embedFn     -> createEmbedder() de embedder-browser             [transformers.js]
//
// js-vector-store se carga como <script> plano antes que este módulo: el engine
// lo toma de globalThis.JSVectorStore (ver getJVS en rag-engine.mjs).

import { RagEngine } from '../rag-poc/rag-engine.mjs';
import { fsaPersistence } from '../rag-poc/fsa-persistence.mjs';
import { createEmbedder } from '../rag-poc/embedder-browser.mjs';

const $ = (id) => document.getElementById(id);
const unlock = (id, yes) => $(id).setAttribute('data-locked', yes ? '0' : '1');

// El engine reporta la validación OKF con UNA LÍNEA POR DOCUMENTO:
//   "Colección inválida — docs con error:\n<id>: title demasiado corto (len=2)"
// Meter eso en un <span> aplasta los saltos y esconde justo lo que hay que
// arreglar. Va a un bloque que respeta los saltos.
function showError(el, err) {
  const msg = typeof err === 'string' ? err : err.message;
  el.textContent = msg;
  el.hidden = false;
}
const clearError = (el) => { el.textContent = ''; el.hidden = true; };

let engine = null;
let dirHandle = null;
let embedFn = null;

// ── 1 · carpeta ────────────────────────────────────────────────────────────

$('pickBtn').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    $('dirStatus').innerHTML = '<span class="bad">Este navegador no tiene File System Access (hace falta Chromium).</span>';
    return;
  }
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'rag-collections' });
  } catch (e) {
    if (e && e.name === 'AbortError') return; // el usuario canceló
    $('dirStatus').innerHTML = `<span class="bad">${e.message}</span>`;
    return;
  }
  $('dirStatus').innerHTML = `carpeta: <code>${dirHandle.name}</code>`;
  unlock('modelPanel', true);
  maybeBuildEngine();
});

// ── 2 · modelo ─────────────────────────────────────────────────────────────

// Progreso de descarga. No es adorno: la primera carga tarda ~94s (medido) y sin
// números es indistinguible de una pestaña colgada — que fue exactamente la
// impresión que dio la primera versión.
const mb = (n) => (n / 1048576).toFixed(0);

function renderProgress(files) {
  const rows = [...files.values()]
    .filter((f) => f.total)
    .map((f) => {
      const pct = Math.min(100, Math.round((f.loaded / f.total) * 100));
      return `<tr>
        <td class="hint">${f.file}</td>
        <td style="width:45%"><div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div></td>
        <td style="text-align:right;font-family:ui-monospace,monospace">${pct}% · ${mb(f.loaded)}/${mb(f.total)} MB</td>
      </tr>`;
    });
  $('modelProgress').innerHTML = rows.length ? `<table>${rows.join('')}</table>` : '';
}

$('loadBtn').addEventListener('click', async () => {
  const device = $('deviceSel').value || undefined;
  $('loadBtn').disabled = true;
  $('deviceSel').disabled = true;
  $('modelStatus').textContent = 'cargando…';

  const files = new Map(); // file -> {file, loaded, total}
  const onProgress = (p) => {
    if (!p || !p.file) return;
    if (p.status === 'progress' || p.status === 'download' || p.status === 'initiate') {
      const prev = files.get(p.file) || { file: p.file, loaded: 0, total: 0 };
      files.set(p.file, { file: p.file, loaded: p.loaded ?? prev.loaded, total: p.total ?? prev.total });
      renderProgress(files);
    } else if (p.status === 'done') {
      const prev = files.get(p.file);
      if (prev && prev.total) { files.set(p.file, { ...prev, loaded: prev.total }); renderProgress(files); }
    }
    // 'ready' llega cuando terminó de compilar: no aporta bytes.
    $('modelStatus').textContent = p.status === 'ready' ? 'inicializando…' : 'cargando…';
  };

  const t0 = performance.now();
  try {
    ({ embedFn } = await createEmbedder({ ...(device ? { device } : {}), onProgress }));
  } catch (e) {
    $('modelStatus').innerHTML = `<span class="bad">falló: ${e.message}</span>`;
    $('loadBtn').disabled = false;
    $('deviceSel').disabled = false;
    return;
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  $('modelProgress').innerHTML = '';
  $('modelStatus').innerHTML = `<span class="ok">listo</span> · ${secs}s · device: ${device ?? 'automático'}`;
  maybeBuildEngine();
});

function maybeBuildEngine() {
  if (!dirHandle || !embedFn) return;
  engine = new RagEngine({ embedFn, persistence: fsaPersistence(dirHandle) });
  unlock('colPanel', true);
  unlock('queryPanel', true);
  refresh();
}

// ── 3 · colecciones ────────────────────────────────────────────────────────

async function refresh() {
  if (!engine) return;
  $('colStatus').textContent = 'leyendo carpeta…';
  let names;
  try {
    names = await engine.listCollections();
  } catch (e) {
    showError($('colError'), e);
    $('colStatus').textContent = '';
    return;
  }
  $('colStatus').textContent = names.length ? `${names.length} colección(es)` : 'la carpeta no tiene ninguna colección todavía';

  $('colTable').innerHTML = names.length
    ? '<tr><th>colección</th><th>archivo</th><th></th></tr>' +
      names.map((n) => `<tr><td>${n}</td><td class="hint"><code>${n}.jvsb</code></td>` +
        `<td><button data-del="${n}" type="button">borrar</button></td></tr>`).join('')
    : '';
  $('colTable').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => del(b.getAttribute('data-del'))));

  $('qCol').innerHTML = names.map((n) => `<option>${n}</option>`).join('');
}

$('refreshBtn').addEventListener('click', refresh);

async function del(name) {
  if (!confirm(`¿Borrar la colección "${name}"? Se elimina ${name}.jvsb de la carpeta.`)) return;
  try {
    await engine.deleteCollection(name);
  } catch (e) {
    showError($('colError'), e);
    return;
  }
  refresh();
}

// Arranque en frío. Sin esto la UI es un callejón: para crear una colección hay
// que elegir archivos .md, y quien llega por primera vez no tiene ninguno ni sabe
// qué es un OKF. Y una colección vacía no es una salida: el engine exige
// okfDocs.length > 0. Así que damos los docs.

const PLANTILLA = `---
type: Nota técnica
title: Mi primera nota
description: Una descripción de más de diez caracteres que resume la nota.
tags: [ejemplo, prueba]
---

# Resumen

Acá va el contenido de la nota. Este texto es lo que se indexa y lo que vas a
poder recuperar después con una consulta.

Reglas del frontmatter: type no vacío, title de 3 caracteres o más,
description de más de 10, y tags como lista entre corchetes.
`;

$('templateBtn').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([PLANTILLA], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mi-primera-nota.md';
  a.click();
  URL.revokeObjectURL(url);
  $('colStatus').textContent = 'plantilla descargada — editala y creá una colección con ella';
});

// El corpus de ejemplo ya vive en el repo (rag-poc/okf-docs.json, 10 docs).
$('demoBtn').addEventListener('click', async () => {
  clearError($('colError'));
  const name = ($('newName').value.trim() || 'ejemplo');
  $('colStatus').textContent = 'trayendo el corpus de ejemplo…';
  let docs;
  try {
    docs = await (await fetch('../rag-poc/okf-docs.json')).json();
  } catch (e) {
    showError($('colError'), `No pude leer el corpus de ejemplo: ${e.message}`);
    return;
  }
  $('colStatus').textContent = `indexando ${docs.length} docs de ejemplo… (un embedding por chunk)`;
  const t0 = performance.now();
  try {
    await engine.createCollection(name, docs);
  } catch (e) {
    $('colStatus').textContent = '';
    showError($('colError'), e);
    return;
  }
  $('colStatus').innerHTML = `<span class="ok">colección "${name}" creada</span> con ${docs.length} docs en ${((performance.now() - t0) / 1000).toFixed(1)}s — probá buscar <em>"diagnóstico médico"</em> abajo`;
  $('newName').value = '';
  refresh();
});

$('createBtn').addEventListener('click', async () => {
  clearError($('colError'));
  const name = $('newName').value.trim();
  if (!name) { showError($('colError'), 'Falta el nombre de la colección.'); return; }

  let files;
  try {
    files = await window.showOpenFilePicker({
      multiple: true,
      types: [{ description: 'OKF markdown', accept: { 'text/markdown': ['.md'] } }],
    });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    showError($('colError'), e);
    return;
  }

  // El engine espera [{ id, md }] — mismo shape que en rag-engine.test.mjs.
  const okfDocs = [];
  for (const fh of files) {
    const file = await fh.getFile();
    okfDocs.push({ id: file.name.replace(/\.md$/i, ''), md: await file.text() });
  }

  $('colStatus').textContent = `indexando ${okfDocs.length} doc(s)… (un embedding por chunk)`;
  const t0 = performance.now();
  try {
    await engine.createCollection(name, okfDocs);
  } catch (e) {
    $('colStatus').textContent = '';
    // Acá cae la validación OKF: type no vacío, title >= 3, description > 10,
    // tags Array. El engine dice qué doc y por qué; mostrarlo entero.
    showError($('colError'), e);
    return;
  }
  $('colStatus').innerHTML = `<span class="ok">creada</span> en ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  $('newName').value = '';
  refresh();
});

// ── 4 · consultar ──────────────────────────────────────────────────────────

$('queryBtn').addEventListener('click', async () => {
  const name = $('qCol').value;
  const text = $('qText').value.trim();
  clearError($('qError'));
  if (!name || !text) { showError($('qError'), 'Elegí una colección y escribí una consulta.'); return; }

  $('qStatus').textContent = 'buscando…';
  $('hits').innerHTML = '';
  const t0 = performance.now();
  let hits;
  try {
    hits = await engine.query(name, text, Number($('qK').value) || 5);
  } catch (e) {
    $('qStatus').textContent = '';
    showError($('qError'), e);
    return;
  }
  $('qStatus').textContent = `${hits.length} resultado(s) en ${(performance.now() - t0).toFixed(0)} ms`;
  $('hits').innerHTML = hits.map((h) => `
    <div class="hit">
      <span class="score">${typeof h.score === 'number' ? h.score.toFixed(3) : ''}</span>
      <div class="meta">${h.id ?? ''}${h.title ? ' · ' + h.title : ''}</div>
      <div>${(h.text ?? h.chunk ?? '').slice(0, 400)}</div>
    </div>`).join('');
});

// ── 5 · dispositivo ────────────────────────────────────────────────────────
// A diferencia de un LLM en WebGPU, acá WebGPU es un acelerador, no un requisito:
// transformers.js cae a WASM solo. Este panel lo dice en vez de dar a entender
// que hace falta.

(async function report() {
  const el = $('devReport');
  const rows = [];
  const fsa = !!window.showDirectoryPicker;
  rows.push(['File System Access', fsa ? 'sí' : 'NO — hace falta Chromium', !fsa]);

  let gpu = false;
  if (navigator.gpu) {
    try { gpu = !!(await navigator.gpu.requestAdapter()); } catch {}
  }
  rows.push(['WebGPU (opcional, acelera)', gpu ? 'sí' : 'no — se usa WASM', false]);

  try {
    const est = await navigator.storage.estimate();
    rows.push(['Cuota de disco', `${((est.quota || 0) / 1073741824).toFixed(1)} GB`, false]);
  } catch {}

  el.innerHTML = '<table>' + rows.map(([k, v, bad]) =>
    `<tr><td>${k}</td><td${bad ? ' class="bad"' : ''} style="text-align:right">${v}</td></tr>`).join('') + '</table>' +
    (fsa
      ? '<p class="hint" style="margin-top:.6rem">WebGPU acá es opcional: el embedder cae a WASM sin él.</p>'
      : '<p class="bad" style="margin-top:.6rem">Sin File System Access no se puede elegir la carpeta de colecciones.</p>');
})();

// ── 6 · API worker ─────────────────────────────────────────────────────────
// Esta pestaña atiende la API mientras esté abierta: es el único lugar donde
// existe el engine (el modelo y la carpeta viven acá). Un Pages Function no
// puede llamar al navegador — no tiene dirección — así que la pestaña pregunta.
//
// /api/next hace long-poll: la request queda abierta del lado del server. Eso
// baja la cuota (un timer de 1.5s son 57.600 requests/día) y, sobre todo, hace
// que el loop avance por eventos de red, que Chrome no throttlea en pestañas de
// fondo. Con setInterval, la API moriría al minimizar la ventana.

const KEY = 'rag_api_secret';
let secret = localStorage.getItem(KEY) || '';
let workerOn = true;
let polled = false; // el server nos aceptó al menos una vez

const auth = () => ({ Authorization: 'Bearer ' + secret });
const wstatus = (s) => { $('workerStatus').textContent = s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Allowlist. El `op` llega de afuera: mapearlo directo a engine[op] sería
// exponer cualquier método del engine a quien tenga el secreto.
const OPS = {
  listCollections: (e) => e.listCollections(),
  createCollection: (e, a) => e.createCollection(a.name, a.docs),
  addDocuments: (e, a) => e.addDocuments(a.name, a.docs),
  deleteCollection: (e, a) => e.deleteCollection(a.name),
  query: (e, a) => e.query(a.name, a.text, a.k ?? 5),

  // export/import mueven el .jvsb entero. Los bytes van por /api/blob, NUNCA por
  // el JSON del buzón: base64+JSON de 20 MB cuesta 33 ms de CPU (medido) contra
  // los 10 ms que da el plan Free, lo que toparía los bundles a ~5 MB. Crudos,
  // el techo es el request body: 100 MB.
  exportBundle: async (e, a, job) => {
    const bundle = await e.exportBundle(a.name);
    const r = await fetch(`/api/blob?id=${encodeURIComponent(job.blobId)}`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, auth()),
      body: bundle,
    });
    if (!r.ok) throw new Error(`no pude subir el bundle: ${r.status}`);
    return { bytes: bundle.byteLength }; // el aviso; los bytes ya están en el blob
  },

  importBundle: async (e, a, job) => {
    const r = await fetch(`/api/blob?id=${encodeURIComponent(job.blobId)}`, { headers: auth() });
    if (!r.ok) throw new Error(`no pude bajar el bundle: ${r.status}`);
    return e.importBundle(a.name, await r.arrayBuffer());
  },
};

async function workerLoop() {
  for (;;) {
    if (!workerOn) { wstatus('desactivado'); await sleep(1000); continue; }
    if (!secret) { wstatus('pegá el API_SECRET acá arriba para atender la API'); await sleep(2000); continue; }
    if (!engine) { wstatus('esperando carpeta + modelo'); await sleep(1500); continue; }

    try {
      let n = 0;
      try { n = (await engine.listCollections()).length; } catch {}
      const q = `?ready=1&dir=${encodeURIComponent(dirHandle?.name || '')}&collections=${n}`;
      // Nada de anunciar "escuchando" ANTES de saber si el server nos acepta: eso
      // hacía que un 401 se leyera como "todo bien" durante el instante previo, y
      // mandó a buscar el problema al lugar equivocado.
      if (!polled) wstatus('conectando con /api/next…');

      const r = await fetch('/api/next' + q, { headers: auth(), cache: 'no-store' });
      if (r.status === 401) { polled = false; secret = ''; localStorage.removeItem(KEY); wstatus('API_SECRET inválido — se borró, pegá el correcto'); await sleep(2000); continue; }
      if (r.status === 503) { wstatus('API_SECRET sin configurar en el server'); await sleep(5000); continue; }
      if (r.status === 404) {
        // Este origen no tiene las Functions: pasa si servís la página con un
        // static server pelado (python -m http.server) en vez de `wrangler pages
        // dev` o Pages. Antes esto giraba en silencio y parecía colgado.
        wstatus('no hay /api acá: servís la página sin Functions. Usá `wrangler pages dev` o el dominio de Pages.');
        await sleep(5000);
        continue;
      }
      if (r.status === 204) { polled = true; wstatus('escuchando — listo para atender'); continue; } // long-poll vencido sin trabajo: normal
      if (r.status !== 200) { wstatus(`/api/next respondió ${r.status}`); await sleep(3000); continue; }

      polled = true;
      const job = await r.json();
      const fn = OPS[job.op];
      let payload;
      if (!fn) {
        payload = { id: job.id, error: `operación no permitida: ${job.op}`, status: 400 };
      } else {
        wstatus(`ejecutando ${job.op}…`);
        try {
          // el job va como 3er argumento: export/import necesitan su blobId
          payload = { id: job.id, value: await fn(engine, job.args || {}, job) };
        } catch (e) {
          // Los errores del engine (validación OKF, colección inexistente) son
          // del que llamó, no del worker: 400, con el motivo entero.
          payload = { id: job.id, error: e.message, status: 400 };
        }
      }
      await fetch('/api/result', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, auth()),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      wstatus('error de red: ' + ((e && e.message) || e));
      await sleep(2000);
    }
  }
}
workerLoop();

$('workerToggle').addEventListener('change', (e) => { workerOn = e.target.checked; });

const secretField = $('secretField');
if (secret) secretField.placeholder = 'guardado — pegá otro para cambiarlo';
$('saveSecret').addEventListener('click', () => {
  secret = secretField.value.trim();
  if (secret) localStorage.setItem(KEY, secret); else localStorage.removeItem(KEY);
  secretField.value = '';
  secretField.placeholder = secret ? 'guardado — pegá otro para cambiarlo' : 'API_SECRET';
});
secretField.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('saveSecret').click(); } });
