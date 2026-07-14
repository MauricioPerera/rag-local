// app.mjs — UI de administración para rag-server. Vanilla JS, sin dependencias.
// Todas las llamadas a la API usan rutas RELATIVAS (misma origin).

const $ = (id) => document.getElementById(id);

// ---- Área de estado global (errores / avisos) ----
const estadoGlobal = $('estado-global');
function setEstado(msg, kind = 'err') {
  if (msg == null || msg === '') {
    estadoGlobal.classList.remove('visible', 'ok');
    estadoGlobal.textContent = '';
    return;
  }
  estadoGlobal.textContent = msg;
  estadoGlobal.classList.add('visible');
  estadoGlobal.classList.toggle('ok', kind === 'ok');
}

// Escapa texto para insertarlo seguro en HTML.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Extrae el frontmatter YAML (campos simples) de un OKF.
function parseOkfFront(md) {
  const out = { type: '', title: '', description: '', tags: [] };
  if (typeof md !== 'string') return out;
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return out;
  const yaml = m[1];
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (k === 'tags') {
      const inner = v.match(/^\[(.*)\]$/);
      out.tags = inner ? inner[1].split(',').map((t) => t.trim()).filter(Boolean) : [];
    } else if (k === 'type' || k === 'title' || k === 'description') {
      out[k] = v.replace(/^["']|["']$/g, '').trim();
    }
  }
  return out;
}

// ---- (a) ESTADO: /health cada 10s + conteo de colecciones ----
async function refreshHealth() {
  const el = $('estado');
  try {
    const r = await fetch('/health');
    if (!r.ok) throw new Error(`health ${r.status}`);
    const j = await r.json();
    el.innerHTML = `<span class="pill ${j.ok ? 'ok' : 'bad'}">${j.ok ? 'OK' : 'DOWN'}</span>` +
      ` <span class="muted">host: ${j.hostConnected ? 'conectado' : '—'}</span>`;
    refreshConteo();
  } catch (e) {
    el.innerHTML = `<span class="pill bad">DOWN</span> <span class="muted">${esc(e.message)}</span>`;
  }
}

async function refreshConteo() {
  try {
    const list = await (await fetch('/collections')).json();
    $('conteo-colecciones').textContent = `${list.length} colección(es) cargada(s).`;
  } catch (e) {
    $('conteo-colecciones').textContent = '';
  }
}

// ---- (b) COLECCIONES: tabla + import ----
async function refreshColecciones() {
  const tbody = $('tabla-colecciones').querySelector('tbody');
  let list;
  try {
    const r = await fetch('/collections');
    if (!r.ok) throw new Error(await r.text());
    list = await r.json();
  } catch (e) {
    setEstado('No se pudo listar colecciones: ' + e.message);
    tbody.innerHTML = '';
    return;
  }
  setEstado(null);
  $('conteo-colecciones').textContent = `${list.length} colección(es) cargada(s).`;

  tbody.innerHTML = list.map((n) => `
    <tr>
      <td>${esc(n)}</td>
      <td class="acciones">
        <button type="button" data-consultar="${esc(n)}">Consultar</button>
        <a href="/collections/${encodeURIComponent(n)}/export" download="${esc(n)}.jvsb">Exportar</a>
        <button type="button" class="danger" data-borrar="${esc(n)}">Borrar</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-consultar]').forEach((b) =>
    b.addEventListener('click', () => consultar(b.getAttribute('data-consultar'))));
  tbody.querySelectorAll('[data-borrar]').forEach((b) =>
    b.addEventListener('click', () => borrar(b.getAttribute('data-borrar'))));

  // Poblar select del playground.
  const sel = $('pg-coleccion');
  const prev = sel.value;
  sel.innerHTML = list.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if (list.includes(prev)) sel.value = prev;
}

async function borrar(name) {
  if (!confirm(`¿Borrar la colección "${name}"?`)) return;
  try {
    const r = await fetch('/collections/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({ error: r.status }));
      setEstado(`Error al borrar "${name}": ${j.error}`);
      return;
    }
    setEstado(`Colección "${name}" borrada.`, 'ok');
    refreshColecciones();
  } catch (e) {
    setEstado('Error al borrar: ' + e.message);
  }
}

async function importar() {
  const file = $('import-file').files[0];
  const name = $('import-name').value.trim();
  const out = $('import-result');
  if (!file) { out.textContent = 'Seleccioná un archivo .jvsb.'; return; }
  if (!name) { out.textContent = 'Ingresá un nombre de colección.'; return; }
  try {
    const buf = await file.arrayBuffer();
    const r = await fetch('/collections/' + encodeURIComponent(name) + '/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    const j = await r.json().catch(() => ({ error: r.status }));
    if (!r.ok) { out.textContent = `Error: ${j.error}`; setEstado(`Import falló: ${j.error}`); return; }
    out.textContent = `Importado: ${j.name} (${j.count} docs).`;
    setEstado(`Import OK: ${j.name} (${j.count}).`, 'ok');
    refreshColecciones();
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
    setEstado('Import falló: ' + e.message);
  }
}

// ---- (c) CREAR COLECCIÓN ----
const PLANTILLA = `[
  {
    "id": "doc-ejemplo",
    "md": "---\\ntype: Nota\\ntitle: Documento de ejemplo\\ndescription: Una descripción breve del documento.\\ntags: [ejemplo, demo]\\n---\\n\\n# Resumen\\n\\nCuerpo del documento en markdown."
  }
]`;

function plantilla() {
  $('crear-docs').value = PLANTILLA;
  $('crear-error').classList.remove('visible');
}

async function crear() {
  const name = $('crear-name').value.trim();
  const errPre = $('crear-error');
  errPre.classList.remove('visible');
  errPre.textContent = '';
  if (!name) { setEstado('Falta el nombre de la colección.'); return; }
  let docs;
  try {
    docs = JSON.parse($('crear-docs').value || '[]');
  } catch (e) {
    setEstado('JSON inválido en el editor de docs: ' + e.message);
    return;
  }
  try {
    const r = await fetch('/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, docs }),
    });
    const text = await r.text();
    if (!r.ok) {
      // 502 con detalle por doc: mostrar el error COMPLETO sin truncar.
      errPre.textContent = `HTTP ${r.status}\n${text}`;
      errPre.classList.add('visible');
      setEstado(`Crear falló (HTTP ${r.status}). Ver detalle abajo.`);
      return;
    }
    setEstado(`Colección creada: ${name}.`, 'ok');
    $('crear-name').value = '';
    refreshColecciones();
  } catch (e) {
    setEstado('Crear falló: ' + e.message);
  }
}

// ---- (d) PLAYGROUND ----
function consultar(name) {
  const sel = $('pg-coleccion');
  if ([...sel.options].some((o) => o.value === name)) sel.value = name;
  $('seccion-playground').scrollIntoView({ behavior: 'smooth' });
}

async function buscar() {
  const name = $('pg-coleccion').value;
  const text = $('pg-text').value;
  const k = Number($('pg-k').value) || 5;
  const cont = $('pg-resultados');
  if (!name) { setEstado('Elegí una colección primero.'); return; }
  cont.innerHTML = '<p class="muted">Buscando…</p>';
  try {
    const r = await fetch('/collections/' + encodeURIComponent(name) + '/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, k }),
    });
    const j = await r.json().catch(() => ({ error: r.status }));
    if (!r.ok) { cont.innerHTML = ''; setEstado(`Query falló: ${j.error}`); return; }
    setEstado(null);
    if (!j.length) { cont.innerHTML = '<p class="muted">Sin resultados.</p>'; return; }
    cont.innerHTML = j.map((d) => {
      const fm = parseOkfFront(d.md);
      const titulo = d.title || fm.title || d.id;
      const tags = (d.tags && d.tags.length ? d.tags : fm.tags) || [];
      const desc = d.description != null ? d.description : fm.description;
      const score = (Number(d.score) || 0).toFixed(4);
      return `
        <div class="tarjeta">
          <div class="titulo">${esc(titulo)}</div>
          <div><span class="id">id: ${esc(d.id)}</span> · <span class="score">score: ${esc(score)}</span></div>
          <div class="chips">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
          <div class="desc">${esc(desc)}</div>
          <details><summary>ver OKF</summary><pre>${esc(d.md)}</pre></details>
        </div>`;
    }).join('');
  } catch (e) {
    cont.innerHTML = '';
    setEstado('Query falló: ' + e.message);
  }
}

// ---- Init ----
$('crear-plantilla').addEventListener('click', plantilla);
$('crear-btn').addEventListener('click', crear);
$('import-btn').addEventListener('click', importar);
$('pg-btn').addEventListener('click', buscar);

refreshHealth();
refreshColecciones();
setInterval(refreshHealth, 10000);