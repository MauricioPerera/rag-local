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

export function composeEmbeddingText(concept) {
  const { title, description, tags } = concept;
  const base = `${title}. ${description}`;
  if (Array.isArray(tags) && tags.length > 0) {
    return `${base} [tags: ${tags.join(', ')}]`;
  }
  return base;
}