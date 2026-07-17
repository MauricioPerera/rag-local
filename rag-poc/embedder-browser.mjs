// embedder-browser.mjs
// Embedder del navegador (ONNX vía transformers.js), gemelo de
// rag-node/embedder-node.mjs. Todo lo que define el vector vive en
// embedder-shared.mjs: acá solo cambia CÓMO se carga el modelo.
//
// Diferencias reales con el de Node, y son solo estas:
//   - No hay env.cacheDir: transformers.js cachea solo en el Cache API del
//     navegador. La primera carga baja ~309MB (dtype 'q8') de Hugging Face.
//   - El import va por CDN (misma convención que el POC), porque en el navegador
//     no hay resolución de node_modules.
//   - Se puede elegir device: 'webgpu' acelera, pero NO es obligatorio —
//     transformers.js cae a WASM solo. Por eso esto anda en dispositivos que no
//     pueden con Bonsai.
//
// Mismo patrón SINGLETON A NIVEL MÓDULO que el de Node: el modelo se carga una
// vez por pestaña y se reutiliza.
//
//   const { embedFn } = await createEmbedder();            // auto (webgpu si hay)
//   const { embedFn } = await createEmbedder({ device: 'wasm' });

import { MODEL_ID, makeEmbedFn } from './embedder-shared.mjs';

const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';

// Promesa singleton: se crea en el primer createEmbedder y se reutiliza.
let loadPromise = null;

function getLoadPromise({ dtype, device, transformers, cdnUrl, onProgress }) {
  if (!loadPromise) {
    loadPromise = (async () => {
      // `transformers` inyectable: el navegador lo trae del CDN, los tests le
      // pasan un doble. Sin esto, esta capa no se podría probar fuera de Chrome.
      const { AutoModel, AutoTokenizer } = transformers ?? (await import(cdnUrl ?? CDN));
      // progress_callback no es cosmético: la primera carga son ~309MB y sin
      // números la pestaña parece colgada durante minutos. transformers.js emite
      // { status, file, progress, loaded, total } por cada archivo.
      const cb = onProgress ? { progress_callback: onProgress } : {};
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, { ...cb });
      const model = await AutoModel.from_pretrained(MODEL_ID, {
        dtype, // "fp32" | "q8" | "q4" (default 'q8' = ~309MB quantized).
        ...(device ? { device } : {}), // sin device, transformers.js elige.
        ...cb,
      });
      return { tokenizer, model };
    })();
  }
  return loadPromise;
}

/**
 * Crea un embedder en el navegador. El modelo se carga una sola vez (singleton).
 * @param {object} opts
 * @param {string} [opts.dtype='q8'] - dtype ONNX ('fp32'|'q8'|'q4').
 * @param {string} [opts.device] - 'webgpu' | 'wasm'. Sin valor: automático.
 * @param {Function} [opts.onProgress] - recibe { status, file, progress, loaded, total }
 *   por cada archivo mientras se descarga. Sin esto la primera carga son minutos
 *   de silencio.
 * @param {object} [opts.transformers] - módulo ya cargado (tests / import propio).
 * @param {string} [opts.cdnUrl] - de dónde importar transformers.js.
 * @returns {Promise<{ embedFn: (text: string, mode?: string) => Promise<number[]> }>}
 */
export async function createEmbedder(opts = {}) {
  const dtype = opts.dtype ?? 'q8';
  const { tokenizer, model } = await getLoadPromise({
    dtype,
    device: opts.device,
    transformers: opts.transformers,
    cdnUrl: opts.cdnUrl,
    onProgress: opts.onProgress,
  });
  return { embedFn: makeEmbedFn({ tokenizer, model }) };
}

// Solo para tests: descarta el singleton.
export function _resetForTests() {
  loadPromise = null;
}
