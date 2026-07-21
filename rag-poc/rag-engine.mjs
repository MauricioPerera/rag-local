// rag-engine.mjs — motor RAG unificado, testeable sin navegador.
// Dependencias inyectadas (embedFn + persistence) para correr idéntico en Node y browser.
// Backing store: JSVectorStore.QuantizedStore (Int8) sobre un MemoryStorageAdapter.

import { parseOKF, composeEmbeddingText, parseMarkdownLinks, isConceptTarget } from './okf.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ─── Contrato de conocimiento (opt-in) ───────────────────────────────────────
// Set builtin de regex anti-referencias-relativas, activado por contract.
// forbid_relative = true. Exportado para que sea testeable y documentable.
export const RELATIVE_PATTERNS = [
  /immediately (after|before)/i,
  /the (next|previous|same) /i,
  /\bdays? (before|after)\b/i,
  /higher|lower than the/i,
];

// Clave bajo la que el contrato se persiste DENTRO del bundle JVSB (como entrada
// json del adapter). No toca el formato binario: el bundle ya empaqueta jsons
// arbitrarios (p.ej. docs.q8.json), así que contract.json viaja como sibling.
const CONTRACT_KEY = 'contract.json';

// Normaliza y valida la forma de un contrato. Devuelve un contrato saneado o
// throw si la forma es inválida (→ rechazo total de la colección). null/undefined
// → null (sin contrato, comportamiento idéntico al actual).
function normalizeContract(contract) {
  if (contract == null) return null;
  if (typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('contrato inválido: debe ser un objeto');
  }
  const c = {};
  if (contract.max_chars !== undefined) {
    if (typeof contract.max_chars !== 'number' || !Number.isFinite(contract.max_chars) || contract.max_chars < 0) {
      throw new Error('contrato inválido: max_chars debe ser un número >= 0');
    }
    c.max_chars = Math.floor(contract.max_chars);
  }
  if (contract.forbid_relative !== undefined) {
    if (typeof contract.forbid_relative !== 'boolean') {
      throw new Error('contrato inválido: forbid_relative debe ser boolean');
    }
    c.forbid_relative = contract.forbid_relative;
  }
  if (contract.forbidden_patterns !== undefined) {
    if (!Array.isArray(contract.forbidden_patterns)) {
      throw new Error('contrato inválido: forbidden_patterns debe ser un array de strings regex');
    }
    c.forbidden_patterns = contract.forbidden_patterns.map((p, i) => {
      if (typeof p !== 'string' || p.length === 0) {
        throw new Error(`contrato inválido: forbidden_patterns[${i}] debe ser un string no vacío`);
      }
      try { new RegExp(p); } catch (e) {
        throw new Error(`contrato inválido: forbidden_patterns[${i}] no es regex válido: ${e.message}`);
      }
      return p;
    });
  }
  if (contract.allowed_tags !== undefined) {
    if (!Array.isArray(contract.allowed_tags)) {
      throw new Error('contrato inválido: allowed_tags debe ser un array de strings');
    }
    c.allowed_tags = contract.allowed_tags.map((t, i) => {
      if (typeof t !== 'string' || t.length === 0) {
        throw new Error(`contrato inválido: allowed_tags[${i}] debe ser un string no vacío`);
      }
      return t;
    });
  }
  if (contract.min_links !== undefined) {
    if (typeof contract.min_links !== 'number' || !Number.isFinite(contract.min_links) || contract.min_links < 0) {
      throw new Error('contrato inválido: min_links debe ser un número >= 0');
    }
    c.min_links = Math.floor(contract.min_links);
  }
  return c;
}

// Aplica un contrato saneado a un doc YA parseado OKF válido. Empuja findings al
// array `errors` con nombre de regla "kc-<rule>" y el formato "id: regla: detalle".
// Devuelve true si el doc cumple (sin findings), false si lo viola.
function applyContract(id, parsed, contract, errors) {
  if (!contract) return true;
  const prose = `${parsed.description || ''}\n${parsed.body || ''}`;
  let ok = true;

  if (contract.max_chars && typeof parsed.description === 'string' && parsed.description.length > contract.max_chars) {
    errors.push(`${id}: kc-max-chars: description de ${parsed.description.length} chars supera el tope de ${contract.max_chars}`);
    ok = false;
  }

  if (contract.forbid_relative) {
    for (const re of RELATIVE_PATTERNS) {
      const m = prose.match(re);
      if (m) {
        errors.push(`${id}: kc-relative: referencia relativa prohibida "${m[0].trim()}"`);
        ok = false;
      }
    }
  }

  if (Array.isArray(contract.forbidden_patterns)) {
    for (const pat of contract.forbidden_patterns) {
      let re;
      try { re = new RegExp(pat); } catch { continue; }
      const m = prose.match(re);
      if (m) {
        errors.push(`${id}: kc-forbidden: patrón prohibido "${pat}" matchea "${m[0].trim()}"`);
        ok = false;
      }
    }
  }

  if (Array.isArray(contract.allowed_tags) && Array.isArray(parsed.tags)) {
    const allowed = new Set(contract.allowed_tags);
    for (const tag of parsed.tags) {
      if (!allowed.has(tag)) {
        errors.push(`${id}: kc-tags: tag "${tag}" no está en allowed_tags`);
        ok = false;
      }
    }
  }

  if (contract.min_links && contract.min_links > 0) {
    const links = parseMarkdownLinks(parsed.body || '').filter((l) => isConceptTarget(l.target));
    if (links.length < contract.min_links) {
      errors.push(`${id}: kc-links: ${links.length} link(s) interno(s), requiere mínimo ${contract.min_links}`);
      ok = false;
    }
  }

  return ok;
}

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

// Valida un lote de docs OKF (estructura + parseo + reglas del validador), SIN
// embeder nada. Devuelve { parsedDocs, errors }: el caller decide si aborta —
// createCollection y addDocuments comparten exactamente estas reglas.
// `contract` opcional (saneado vía normalizeContract): si está, aplica sus reglas
// por-doc (kc-*) con el mismo formato de error "id: regla: detalle".
function validateOkfDocs(okfDocs, contract = null) {
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
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${id}: id duplicado`);
      continue;
    }
    seen.add(id);

    let parsed;
    try {
      parsed = parseOKF(doc.md);
    } catch (e) {
      errors.push(`${id}: no parsea como OKF (${e.message})`);
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
      continue;
    }

    // Contrato de conocimiento (opt-in): reglas kc-* sobre el doc ya válido.
    if (contract && !applyContract(id, parsed, contract, errors)) {
      continue;
    }

    parsedDocs.push({ id, parsed, md: doc.md });
  }
  return { parsedDocs, errors };
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

  async createCollection(name, okfDocs, contract) {
    validateName(name);

    const existing = await this.persistence.list();
    if (existing.includes(name)) {
      throw new Error(`La colección ya existe: "${name}"`);
    }

    // Contrato: normaliza la forma (invalid → throw, rechazo total) y luego
    // valida los docs contra él junto a las reglas OKF base.
    const normContract = normalizeContract(contract);

    // Validación completa ANTES de embeder nada. Si algo falla, no persiste.
    const { parsedDocs, errors } = validateOkfDocs(okfDocs, normContract);
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

    // Persiste el contrato DENTRO del bundle (entrada json del adapter). No
    // toca el formato binario JVSB: viaja como sibling de docs.q8.json.
    if (normContract) adapter.writeJson(CONTRACT_KEY, normContract);

    store.flush();
    const bundle = adapter.toBundle();
    await this.persistence.save(name, bundle);
    this._cache.set(name, { store, adapter });

    return { name, count: store.count('docs') };
  }

  // Agrega docs a una colección EXISTENTE (append incremental). Mismas reglas
  // OKF que createCollection. Carga el store, embebe los nuevos, y reescribe el
  // bundle entero: el .jvsb no se appendea en disco byte-a-byte (no es SQLite),
  // pero el vector nuevo queda persistido y consultable. Rechaza ids que ya
  // viven en la colección: append agrega, no pisa (para reemplazar: borrar +
  // recrear, o usar otro id).
  async addDocuments(name, okfDocs) {
    validateName(name);

    const existing = await this.persistence.list();
    if (!existing.includes(name)) {
      throw new Error(`La colección no existe: "${name}"`);
    }

    const { parsedDocs, errors } = validateOkfDocs(okfDocs, await this._loadContract(name));

    // Cargar el store existente y cruzar contra sus ids ya presentes.
    const store = await this._getStore(name);
    const { adapter } = this._cache.get(name);
    const manifest = adapter.readJson('docs.q8.json');
    const existingIds = new Set(manifest && Array.isArray(manifest.ids) ? manifest.ids : []);
    for (const { id } of parsedDocs) {
      if (existingIds.has(id)) errors.push(`${id}: ya existe en la colección "${name}"`);
    }

    if (errors.length > 0) {
      throw new Error(`No se agregó nada — docs con error:\n${errors.join('\n')}`);
    }

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

    return { name, added: parsedDocs.length, count: store.count('docs') };
  }

  // Upsert de un doc por id: si existe lo reemplaza, si no lo crea (store.set es
  // upsert). Mismas reglas OKF. Re-embebe con el nuevo md y reescribe el bundle.
  // `created` en la respuesta distingue alta de edición.
  async updateDocument(name, id, md) {
    validateName(name);

    const existing = await this.persistence.list();
    if (!existing.includes(name)) {
      throw new Error(`La colección no existe: "${name}"`);
    }

    const { parsedDocs, errors } = validateOkfDocs([{ id, md }], await this._loadContract(name));
    if (errors.length > 0) {
      throw new Error(`Doc inválido:\n${errors.join('\n')}`);
    }

    const store = await this._getStore(name);
    const { adapter } = this._cache.get(name);
    const manifest = adapter.readJson('docs.q8.json');
    const ids = new Set(manifest && Array.isArray(manifest.ids) ? manifest.ids : []);
    const created = !ids.has(id);

    const { parsed } = parsedDocs[0];
    const vector = await this.embedFn(composeEmbeddingText(parsed), 'document');
    store.set('docs', id, vector, {
      title: parsed.title,
      type: parsed.type,
      tags: parsed.tags,
      description: parsed.description,
      md,
    });

    store.flush();
    await this.persistence.save(name, adapter.toBundle());
    this._cache.set(name, { store, adapter });

    return { name, id, created, count: store.count('docs') };
  }

  // Borra un doc de la colección. Rechaza el último: una colección vacía no es
  // válida (el bundle no tiene dim derivable y query rompería) — para eso está
  // deleteCollection.
  async removeDocument(name, id) {
    validateName(name);

    const existing = await this.persistence.list();
    if (!existing.includes(name)) {
      throw new Error(`La colección no existe: "${name}"`);
    }

    const store = await this._getStore(name);
    const { adapter } = this._cache.get(name);
    const manifest = adapter.readJson('docs.q8.json');
    const ids = manifest && Array.isArray(manifest.ids) ? manifest.ids : [];
    if (!ids.includes(id)) {
      throw new Error(`El doc no existe en "${name}": "${id}"`);
    }
    if (ids.length <= 1) {
      throw new Error(`No se puede borrar el último doc de "${name}" (una colección vacía no es válida). Borrá la colección entera con DELETE /api/collections/${name}.`);
    }

    if (!store.remove('docs', id)) {
      throw new Error(`no se pudo borrar el doc "${id}" de "${name}"`);
    }

    store.flush();
    await this.persistence.save(name, adapter.toBundle());
    this._cache.set(name, { store, adapter });

    return { name, id, count: store.count('docs') };
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

  // Devuelve el contrato persistido de la colección (o null si no tiene).
  // Fuerza la carga del store (y su adapter) para leer contract.json del bundle.
  async _loadContract(name) {
    await this._getStore(name);
    const { adapter } = this._cache.get(name);
    const c = adapter.readJson(CONTRACT_KEY);
    return c || null;
  }

  // Proyecta un registro del store (con metadata) al shape público de query.
  _toHit(rec, extra = {}) {
    const md = rec.metadata.md;
    return {
      id: rec.id,
      score: rec.score,
      title: rec.metadata.title,
      type: rec.metadata.type,
      tags: rec.metadata.tags,
      description: rec.metadata.description,
      md,
      ...extra,
    };
  }

  async query(name, text, k = 5, options = {}) {
    const store = await this._getStore(name);
    const qv = await this.embedFn(text, 'query');
    const results = store.search('docs', qv, k, 0, 'cosine');
    let hits = results.map((r) => this._toHit(r));

    // ─── Opciones opt-in (ausencia = comportamiento idéntico al previo) ───────
    // threshold: filtra los hits normales por score >= threshold ANTES de
    // expandir. La expansión parte SOLO de los sobrevivientes y puede rescatar
    // CUALQUIER doc linkeado que no esté entre ellos — incluido uno que apareció
    // entre los k crudos pero quedó bajo el umbral (fix del GAP 1: ese doc ya no
    // está en `seen` porque se descartó como hit normal, así que entra por link).
    const threshold = options && typeof options.threshold === 'number' && Number.isFinite(options.threshold)
      ? options.threshold
      : null;
    if (threshold !== null) {
      hits = hits.filter((h) => h.score >= threshold);
    }

    // hops: cuántos saltos de expansión. Default 1 (= 1 salto, comportamiento
    // actual). Tope duro de 3 aunque pidan más. Inválido/no-finito/<1 → 1.
    // Sólo importa con expand_links; sin expansión se ignora.
    let hops = 1;
    if (options && options.hops != null) {
      const n = Number(options.hops);
      hops = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 3) : 1;
    }

    // Expansión de links (opt-in). Default false → solo los top-k (ya
    // filtrados por threshold si vino). Con hops=N se repite N veces: los
    // expandidos en el salto i son fuente de links para el salto i+1.
    if (options && options.expand_links) {
      const existingIds = new Set(store.ids('docs'));
      // seen = dedup GLOBAL: un doc aparece a lo sumo una vez en el resultado
      // final. Arranca con los hits normales sobrevivientes (jamás se re-agregan).
      // via = el doc que PRIMERO lo linkeó (orden de resultado → orden de BFS).
      const seen = new Set(hits.map((h) => h.id));
      const expanded = [];
      // frontier = fuentes del próximo salto. Salto 0 parte de los sobrevivientes.
      let frontier = hits.slice();
      for (let hop = 0; hop < hops; hop++) {
        const nextFrontier = [];
        for (const src of frontier) {
          // Links markdown del body de la fuente cuyo destino es un concept-id
          // EXISTENTE y aún no visto.
          const targets = parseMarkdownLinks(src.md || '')
            .map((l) => l.target)
            .filter((t) => isConceptTarget(t) && existingIds.has(t) && !seen.has(t));
          for (const target of targets) {
            // Re-chequeo intra-fuente: el filter de arriba se evalúa de una sola
            // vez ANTES de este loop, así que un link repetido dos veces en el md
            // de la fuente (p.ej. en la description del frontmatter Y en el body)
            // pasa dos veces el `!seen.has(t)`. Acá lo frenamos.
            if (seen.has(target)) continue;
            seen.add(target);
            const rec = store.get('docs', target);
            if (!rec) continue;
            const exp = this._toHit(rec, { expanded: true, via: src.id, score: null });
            expanded.push(exp);
            nextFrontier.push(exp);
          }
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break; // nada nuevo que seguir expandiendo
      }
      hits.push(...expanded);
    }

    return hits;
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