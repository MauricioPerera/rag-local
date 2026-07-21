// okf.mjs — modulo zero-dependencias para OKF (Open Knowledge Format).
// Subset YAML soportado: pares "clave: valor" string y tags inline "[a, b, c]".
// Sin comillas o con comillas simples/dobles. Sin librerias.

function stripQuotes(value) {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function parseInlineList(raw) {
  // raw => "[a, b, c]" o "a, b, c"
  let s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1);
  }
  if (s.trim() === '') return [];
  return s
    .split(',')
    .map((item) => stripQuotes(item))
    .filter((item) => item !== '');
}

export function parseOKF(mdText) {
  const text = String(mdText);
  const lines = text.split('\n');

  // El frontmatter arranca con una linea "---" y termina con la siguiente "---".
  if (lines.length === 0 || lines[0].trim() !== '---') {
    // Sin frontmatter: todo es body.
    return { type: '', title: '', description: '', tags: [], body: text.trim() };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }

  const result = { type: '', title: '', description: '', tags: [], body: '' };

  if (endIdx === -1) {
    // No se cerro el frontmatter: tratamos todo como frontmatter, body vacio.
    const fmLines = lines.slice(1);
    parseFrontmatter(fmLines, result);
    result.body = '';
    return result;
  }

  const fmLines = lines.slice(1, endIdx);
  parseFrontmatter(fmLines, result);

  const bodyLines = lines.slice(endIdx + 1);
  result.body = bodyLines.join('\n').trim();

  return result;
}

function parseFrontmatter(fmLines, result) {
  for (const line of fmLines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1);

    if (key === 'tags') {
      result.tags = parseInlineList(rawValue);
    } else if (key === 'type') {
      result.type = stripQuotes(rawValue);
    } else if (key === 'title') {
      result.title = stripQuotes(rawValue);
    } else if (key === 'description') {
      result.description = stripQuotes(rawValue);
    }
  }
}

// Parsing de links markdown [text](target) del cuerpo/body de un doc OKF.
// Devuelve [{text, target}] en orden de aparición. `target` es el primer token
// dentro de los paréntesis (sin el título opcional "…"), recortado.
// No filtra por tipo de destino: el caller decide qué cuenta como concept-id
// (p.ej. excluir URLs http/https/mailto). Links sin target → se omiten.
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
export function parseMarkdownLinks(text) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  MARKDOWN_LINK_RE.lastIndex = 0;
  let m;
  while ((m = MARKDOWN_LINK_RE.exec(text)) !== null) {
    const rawTarget = m[2] || '';
    // "id" o "id \"title\"": el destino es el primer token antes del espacio.
    const target = rawTarget.split(/\s/)[0].trim();
    if (target === '') continue;
    out.push({ text: m[1], target });
  }
  return out;
}

// True si `target` parece un concept-id (no una URL externa). Usado para contar
// links internos (min_links) y para expandir solo referencias a concepts.
export function isConceptTarget(target) {
  if (typeof target !== 'string' || target.length === 0) return false;
  if (/^(https?:|mailto:|\/\/|#|\.\/|\.\.\/)/i.test(target)) return false;
  if (target.includes('://')) return false;
  return true;
}

export function composeEmbeddingText(concept) {
  const { title, description, tags } = concept;
  const base = `${title}. ${description}`;
  if (Array.isArray(tags) && tags.length > 0) {
    return `${base} [tags: ${tags.join(', ')}]`;
  }
  return base;
}