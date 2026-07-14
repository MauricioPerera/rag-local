// rag-engine.mjs — motor RAG unificado, testeable sin navegador.
// Dependencias inyectadas (embedFn + persistence) para correr idéntico en Node y browser.
// Backing store: JSVectorStore.QuantizedStore (Int8) sobre un MemoryStorageAdapter.

import { parseOKF, composeEmbeddingText } from './okf.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Carga perezosa y portable de js-vector-store:
//   - browser/Worker: globalThis.JSVectorStore (UMD-lite del bundle).
//   - Node ESM: createRequire(import.meta.url)('./js-vector-store.js').
// El módulo carga en browser sin error: el import dinámico de 'node:module'
// sólo se evalúa si no hay global (caso Node), nunca en browser.
let _jvsApi = null;
async function getJVS() {
  if (_jvsApi) return _jvsApi;
  if (typeof globalThis !== 'undefined' && globalThis.JSVectorStore) {
    _jvsApi = globalThis.JSVectorStore;
    return _jvsApi;
  }
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  _jvsApi = require('./js-vector-store.js');
  return _jvsApi;
}

function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`Nombre de colección inválido: "${name}" (debe matchear ${NAME_RE})`);
  }
}

// Deriva la dimensión REAL de los vectores de la colección interna `col`
// directamente del binario cuantizado y el manifest del adapter.
// El formato del bundle no guarda la dim de forma fiable, pero el QuantizedStore
// packing cada vector con stride = 8 (float32 min + float32 max) + dim (Int8) bytes:
//   dimDerivada = (bin.byteLength / cantidadDeVectores) - 8
// Si no hay binario/manifest legible, se trata como bundle inválido (throw).
function _deriveDim(adapter, col = 'docs') {
  const manifest = adapter.readJson(`${col}.q8.json`);
  if (!manifest || !Array.isArray(manifest.ids)) {
    throw new Error(`bundle inválido: manifest ilegible para la colección interna "${col}"`);
  }
  const count = manifest.ids.length;
  if (count <= 0) {
    throw new Error(`bundle inválido: colección interna "${col}" vacía`);
  }
  const bin = adapter.readBin(`${col}.q8.bin`);
  if (!bin || bin.byteLength <= 0) {
    throw new Error(`bundle inválido: binario ilegible para la colección interna "${col}"`);
  }
  if (bin.byteLength % count !== 0) {
    throw new Error(`bundle inválido: tamaño de binario inconsistente para la colección interna "${col}"`);
  }
  const stride = bin.byteLength / count;
  if (stride <= 8) {
    throw new Error(`bundle inválido: stride inconsistente para la colección interna "${col}"`);
  }
  return stride - 8;
}

// Validación defensiva de dimensión: la dim derivada del store debe coincidir
// con la dim declarada por el engine. Si difiere, throw con ambas dimensiones
// (evita queries con scores basura por lectura fuera de rango).
function _assertDim(expected, derived, name) {
  if (derived !== expected) {
    throw new Error(
      `dim incompatible para "${name}": esperada ${expected}, derivada ${derived}`,
    );
  }
}

export class RagEngine {
  constructor({ embedFn, persistence, dim = 768 }) {
    if (typeof embedFn !== 'function') throw new Error('embedFn es obligatorio');
    if (!persistence || typeof persistence.save !== 'function') throw new Error('persistence es obligatorio');
    this.embedFn = embedFn;
    this.persistence = persistence;
    this.dim = dim;
    // cache en memoria: name -> { store, adapter }
    this._cache = new Map();
  }

  async listCollections() {
    return this.persistence.list();
  }

  async createCollection(name, okfDocs) {
    validateName(name);

    const existing = await this.persistence.list();
    if (existing.includes(name)) {
      throw new Error(`La colección ya existe: "${name}"`);
    }

    // Validación completa ANTES de embeder nada. Si algo falla, no persiste.
    if (!Array.isArray(okfDocs) || okfDocs.length === 0) {
      throw new Error('okfDocs debe ser un array no vacío');
    }
    const seen = new Set();
    const errors = [];
    const parsedDocs = [];
    for (const doc of okfDocs) {
      const id = doc && doc.id;
      if (typeof id !== 'string' || id.length === 0) {
        errors.push(`id inválido (no es string no vacío): ${JSON.stringify(id)}`);
        parsedDocs.push(null);
        continue;
      }
      if (seen.has(id)) {
        errors.push(`${id}: id duplicado`);
        parsedDocs.push(null);
        continue;
      }
      seen.add(id);

      let parsed;
      try {
        parsed = parseOKF(doc.md);
      } catch (e) {
        errors.push(`${id}: no parsea como OKF (${e.message})`);
        parsedDocs.push(null);
        continue;
      }

      const reasons = [];
      if (!parsed.type) reasons.push('type vacío');
      if (typeof parsed.title !== 'string' || parsed.title.length < 3) {
        reasons.push(`title demasiado corto (len=${parsed.title ? parsed.title.length : 0})`);
      }
      if (typeof parsed.description !== 'string' || parsed.description.length <= 10) {
        reasons.push(`description demasiado corta (len=${parsed.description ? parsed.description.length : 0}, debe ser > 10)`);
      }
      if (!Array.isArray(parsed.tags)) reasons.push('tags no es Array');

      if (reasons.length > 0) {
        errors.push(`${id}: ${reasons.join('; ')}`);
        parsedDocs.push(null);
        continue;
      }
      parsedDocs.push({ id, parsed, md: doc.md });
    }

    if (errors.length > 0) {
      throw new Error(`Colección inválida — docs con error:\n${errors.join('\n')}`);
    }

    // Todo válido: embeder e indexar.
    const JVS = await getJVS();
    const adapter = new JVS.MemoryStorageAdapter();
    const store = new JVS.QuantizedStore(adapter, this.dim);

    for (const { id, parsed, md } of parsedDocs) {
      const text = composeEmbeddingText(parsed);
      const vector = await this.embedFn(text, 'document');
      store.set('docs', id, vector, {
        title: parsed.title,
        type: parsed.type,
        tags: parsed.tags,
        description: parsed.description,
        md,
      });
    }

    store.flush();
    const bundle = adapter.toBundle();
    await this.persistence.save(name, bundle);
    this._cache.set(name, { store, adapter });

    return { name, count: store.count('docs') };
  }

  async _getStore(name) {
    const cached = this._cache.get(name);
    if (cached) return cached.store;

    const buf = await this.persistence.load(name);
    if (!buf) throw new Error(`Colección inexistente: "${name}"`);

    const JVS = await getJVS();
    const adapter = JVS.MemoryStorageAdapter.fromBundle(buf);
    const store = new JVS.QuantizedStore(adapter, this.dim);
    const derivedDim = _deriveDim(adapter, 'docs');
    _assertDim(this.dim, derivedDim, name);
    this._cache.set(name, { store, adapter });
    return store;
  }

  async query(name, text, k = 5) {
    const store = await this._getStore(name);
    const qv = await this.embedFn(text, 'query');
    const results = store.search('docs', qv, k, 0, 'cosine');
    return results.map((r) => ({
      id: r.id,
      score: r.score,
      title: r.metadata.title,
      type: r.metadata.type,
      tags: r.metadata.tags,
      description: r.metadata.description,
      md: r.metadata.md,
    }));
  }

  async exportBundle(name) {
    const buf = await this.persistence.load(name);
    if (!buf) throw new Error(`Colección inexistente: "${name}"`);
    return buf;
  }

  async importBundle(name, arrayBuffer) {
    validateName(name);

    const existing = await this.persistence.list();
    if (existing.includes(name)) {
      throw new Error(`La colección ya existe: "${name}"`);
    }

    const JVS = await getJVS();
    let adapter;
    try {
      adapter = JVS.MemoryStorageAdapter.fromBundle(arrayBuffer);
    } catch (e) {
      throw new Error(`bundle inválido para "${name}": ${e.message}`);
    }
    const store = new JVS.QuantizedStore(adapter, this.dim);
    if (store.count('docs') <= 0) {
      throw new Error(`bundle inválido para "${name}": colección interna "docs" vacía`);
    }
    const derivedDim = _deriveDim(adapter, 'docs');
    _assertDim(this.dim, derivedDim, name);

    await this.persistence.save(name, arrayBuffer);
    this._cache.set(name, { store, adapter });
    return { name, count: store.count('docs') };
  }

  async deleteCollection(name) {
    const existing = await this.persistence.list();
    if (!existing.includes(name)) {
      throw new Error(`La colección no existe: "${name}"`);
    }
    await this.persistence.delete(name);
    this._cache.delete(name);
  }
}