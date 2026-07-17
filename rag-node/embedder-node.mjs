// embedder-node.mjs
// Embedder de Node puro (ONNX) para la fase producción de rag-node.
// Reemplaza al embedder del navegador (LiteRT.js) del POC por uno basado en
// @huggingface/transformers + modelo onnx-community/embeddinggemma-300m-ONNX.
//
// Gemelo de rag-poc/embedder-browser.mjs. Lo que define el vector (MODEL_ID,
// prefijos, normalización) vive en rag-poc/embedder-shared.mjs y lo comparten
// los dos: si divergiera, las colecciones indexadas en Node darían basura al
// consultarlas desde el navegador, sin ningún error visible.
//
// Patrón de carga: SINGLETON A NIVEL MÓDULO. El modelo y el tokenizer se cargan
// UNA sola vez por proceso (la promesa `loadPromise` se reutiliza en todas las
// llamadas a createEmbedder). La primera carga descarga ~309MB al cache de HF
// (dtype 'q8' = model_quantized) y no se borra. Las llamadas subsiguientes a
// createEmbedder reutilizan la misma instancia ya cargada en memoria.

import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MODEL_ID, makeEmbedFn } from '../rag-poc/embedder-shared.mjs';

// Cache del modelo FUERA de node_modules (el default vive dentro y un
// `npm install` limpio lo borraría, forzando re-descarga de ~316MB).
env.cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'models');

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

/**
 * Crea un embedder. El modelo se carga una sola vez (singleton de módulo).
 * @param {object} opts
 * @param {string} [opts.dtype='q8'] - dtype del modelo ONNX ('fp32'|'q8'|'q4').
 * @returns {Promise<{ embedFn: (text: string, mode?: string) => Promise<number[]> }>}
 */
export async function createEmbedder(opts = {}) {
  const dtype = opts.dtype ?? 'q8';
  const { tokenizer, model } = await getLoadPromise(dtype);
  return { embedFn: makeEmbedFn({ tokenizer, model }) };
}
