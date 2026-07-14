// rag-host.mjs — página "host" que sirve el motor RAG real al bridge (:8937).
// Carga el modelo LiteRT (mismo patrón que app.js) y atiende jobs via polling.

import { WebGPUBackend } from 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.22.0/+esm';
import * as tf from 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/+esm';
import { loadLiteRt, loadAndCompile, isWebGPUSupported, getWebGpuDevice } from 'https://cdn.jsdelivr.net/npm/@litertjs/core@2.4.0/+esm';
import { runWithTfjsTensors } from 'https://cdn.jsdelivr.net/npm/@litertjs/tfjs-interop@2.5.0/+esm';
import { PreTrainedTokenizer } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers/+esm';
import { RagEngine } from './rag-engine.mjs';

const {
  idbSaveBundle, idbLoadBundle, idbListBundles, idbDeleteBundle,
} = window.JSVectorStore;

const DB = 'rag-host-collections';
const BRIDGE = 'http://localhost:8937';
const MODELS_BASE = '../embed-demo/models';
const SEQ_LEN = 256;

const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Embedder (copia del patrón de app.js) ───────────────────

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

function buildPrompt(text, mode) {
  if (mode === 'query') return `task: search result | query: ${text}`;
  if (mode === 'document') return `title: none | text: ${text}`;
  return `task: sentence similarity | query: ${text}`;
}

function l2normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
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

// embedFn inyectada en el engine: prompt asimétrico + inferencia + L2 normalize → 768d.
async function embedFn(text, mode) {
  return embed(text, mode);
}

// ── Persistence sobre IndexedDB ─────────────────────────────

const persistence = {
  save: (name, buf) => idbSaveBundle(name, buf, DB),
  load: (name) => idbLoadBundle(name, DB),
  list: () => idbListBundles(DB),
  delete: (name) => idbDeleteBundle(name, DB),
};

const engine = new RagEngine({ embedFn, persistence, dim: 768 });

// ── base64 ⇄ ArrayBuffer (en chunks para no reventar el stack) ──

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── Despacho de jobs del bridge ─────────────────────────────

async function dispatch(job) {
  const { method, params = {} } = job;
  switch (method) {
    case 'listCollections':
      return { result: await engine.listCollections() };
    case 'createCollection':
      return { result: await engine.createCollection(params.name, params.docs) };
    case 'query':
      return { result: await engine.query(params.name, params.text, params.k ?? 5) };
    case 'exportBundle': {
      const buf = await engine.exportBundle(params.name);
      return { result: { base64: arrayBufferToBase64(buf) } };
    }
    case 'importBundle': {
      const buf = base64ToArrayBuffer(params.base64);
      return { result: await engine.importBundle(params.name, buf) };
    }
    case 'deleteCollection':
      await engine.deleteCollection(params.name);
      return { result: { ok: true } };
    default:
      return { error: `unknown method ${method}` };
  }
}

// ── Poll loop contra el bridge ──────────────────────────────

let bridgeDown = false;

async function postResult(jobId, payload) {
  try {
    await fetch(`${BRIDGE}/host/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, ...payload }),
    });
  } catch (e) {
    // El result no pudo entregarse; lo reportamos en log pero no frenamos el poll.
    log(`POST /host/result falló para jobId=${jobId}: ${e.message}`);
  }
}

async function pollOnce() {
  let res;
  try {
    res = await fetch(`${BRIDGE}/host/poll`);
  } catch (e) {
    if (!bridgeDown) {
      bridgeDown = true;
      statusEl.textContent = 'bridge no disponible — reintentando cada 2s';
      log('bridge no disponible — reintentando cada 2s');
    }
    return 2000; // bridge caído: reintento lento
  }

  if (bridgeDown) {
    bridgeDown = false;
    statusEl.textContent = 'listo — atendiendo bridge en :8937';
    log('bridge disponible de nuevo');
  }

  if (res.status === 204) return 300; // sin trabajo
  if (res.status !== 200) return 300;

  const job = await res.json();
  const t0 = performance.now();
  try {
    const out = await dispatch(job);
    const ms = (performance.now() - t0).toFixed(0);
    const name = job.params && job.params.name ? job.params.name : '-';
    log(`job atendido: ${job.method} ${name} — ${ms}ms`);
    await postResult(job.jobId, out);
  } catch (e) {
    const ms = (performance.now() - t0).toFixed(0);
    const name = job.params && job.params.name ? job.params.name : '-';
    log(`job con error: ${job.method} ${name} — ${ms}ms — ${e.message}`);
    await postResult(job.jobId, { error: e.message });
  }
  return 300;
}

async function pollLoop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const wait = await pollOnce();
    await new Promise(r => setTimeout(r, wait));
  }
}

// ── Arranque: modelo primero, poll después ──────────────────

async function main() {
  try {
    await initEmbedder();
    statusEl.textContent = 'listo — atendiendo bridge en :8937';
    log('modelo listo — arrancando poll contra el bridge');
    pollLoop();
  } catch (e) {
    statusEl.textContent = 'Error cargando modelo: ' + e.message;
    log('ERROR: ' + e.stack);
  }
}

main();