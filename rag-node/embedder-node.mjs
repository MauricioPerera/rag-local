// embedder-node.mjs
// Embedder de Node puro (ONNX) para la fase producción de rag-node.
// Reemplaza al embedder del navegador (LiteRT.js) del POC por uno basado en
// @huggingface/transformers + modelo onnx-community/embeddinggemma-300m-ONNX.
//
// Patrón de carga: SINGLETON A NIVEL MÓDULO. El modelo y el tokenizer se cargan
// UNA sola vez por proceso (la promesa `loadPromise` se reutiliza en todas las
// llamadas a createEmbedder). La primera carga descarga ~309MB al cache de HF
// (dtype 'q8' = model_quantized) y no se borra. Las llamadas subsiguientes a
// createEmbedder reutilizan la misma instancia ya cargada en memoria.

import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Cache del modelo FUERA de node_modules (el default vive dentro y un
// `npm install` limpio lo borraría, forzando re-descarga de ~316MB).
env.cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'models');

const MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX';

// Promesa singleton: se crea en el primer createEmbedder y se reutiliza.
let loadPromise = null;

function getLoadPromise(dtype) {
  if (!loadPromise) {
    loadPromise = (async () => {
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      const model = await AutoModel.from_pretrained(MODEL_ID, {
        dtype, // "fp32" | "q8" | "q4" (default 'q8' = ~309MB quantized).
      });
      return { tokenizer, model };
    })();
  }
  return loadPromise;
}

// Prompts asimétricos EXACTOS (paridad con el POC).
const PREFIXES = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
  similarity: 'task: sentence similarity | query: ',
};

function promptFor(text, mode) {
  const prefix = PREFIXES[mode] ?? PREFIXES.similarity;
  return prefix + text;
}

// L2-normaliza un vector (el modelo emite sentence_embedding ya ~normalizado,
// pero normalizamos explícitamente para garantizar norma ≈ 1).
function l2Normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * Crea un embedder. El modelo se carga una sola vez (singleton de módulo).
 * @param {object} opts
 * @param {string} [opts.dtype='q8'] - dtype del modelo ONNX ('fp32'|'q8'|'q4').
 * @returns {Promise<{ embedFn: (text: string, mode?: string) => Promise<number[]> }>}
 */
export async function createEmbedder(opts = {}) {
  const dtype = opts.dtype ?? 'q8';
  const { tokenizer, model } = await getLoadPromise(dtype);

  /**
   * @param {string} text
   * @param {string} [mode='similarity'] - 'query' | 'document' | 'similarity'
   * @returns {Promise<number[]>} embedding de 768 dims, L2-normalizado.
   */
  async function embedFn(text, mode = 'similarity') {
    const prompted = promptFor(text, mode);
    const inputs = tokenizer(prompted);
    const { sentence_embedding } = await model(inputs);
    // sentence_embedding: Tensor [1, 768] -> Array<number> de 768.
    const vec = sentence_embedding.tolist()[0];
    return l2Normalize(vec);
  }

  return { embedFn };
}