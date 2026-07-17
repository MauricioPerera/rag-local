// embedder-shared.mjs
// Lo que Node y el navegador tienen que calcular EXACTAMENTE igual.
//
// Por qué existe este archivo: lo único que separa a embedder-node.mjs de
// embedder-browser.mjs son tres líneas de carga (cacheDir en Node, CDN en el
// navegador). Todo lo demás —el MODEL_ID, los prefijos asimétricos y la
// normalización L2— define QUÉ VECTOR sale para un texto dado. Si los dos
// embedders llevan su propia copia y alguien toca un prefijo en uno solo, las
// colecciones quedan incompatibles EN SILENCIO: los .jvsb siguen abriendo, los
// bytes siguen siendo válidos, y la recuperación devuelve basura porque los
// vectores se calcularon con otro prompt.
//
// Eso es justo lo que fsa-persistence promete que no pasa (indexar en Node,
// consultar en el navegador). La garantía vive acá.

export const MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX';

// Prompts asimétricos EXACTOS (paridad con el POC).
export const PREFIXES = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
  similarity: 'task: sentence similarity | query: ',
};

export function promptFor(text, mode) {
  const prefix = PREFIXES[mode] ?? PREFIXES.similarity;
  return prefix + text;
}

// L2-normaliza un vector (el modelo emite sentence_embedding ya ~normalizado,
// pero normalizamos explícitamente para garantizar norma ≈ 1).
export function l2Normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * Construye el embedFn a partir de un tokenizer/model ya cargados. El cómo se
 * cargan es lo único que cambia entre Node y navegador; el qué se calcula, no.
 * @param {{tokenizer: Function, model: Function}} deps
 * @returns {(text: string, mode?: string) => Promise<number[]>} 768 dims, L2-normalizado.
 */
export function makeEmbedFn({ tokenizer, model }) {
  return async function embedFn(text, mode = 'similarity') {
    const prompted = promptFor(text, mode);
    const inputs = tokenizer(prompted);
    const { sentence_embedding } = await model(inputs);
    // sentence_embedding: Tensor [1, 768] -> Array<number> de 768.
    const vec = sentence_embedding.tolist()[0];
    return l2Normalize(vec);
  };
}
