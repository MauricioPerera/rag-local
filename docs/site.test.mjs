import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('./docs/index.html', 'utf8');
const i18n = JSON.parse(readFileSync('./docs/i18n.json', 'utf8'));

test('i18n: es/en/pt con el mismo set de claves y >= 45 claves', () => {
  const langs = ['es', 'en', 'pt'];
  for (const l of langs) assert.ok(i18n[l], l);
  const keysES = Object.keys(i18n.es).sort();
  assert.ok(keysES.length >= 45, `claves: ${keysES.length}`);
  for (const l of ['en', 'pt']) {
    assert.deepEqual(Object.keys(i18n[l]).sort(), keysES, `set de claves difiere en ${l}`);
  }
  for (const l of langs) {
    for (const [k, v] of Object.entries(i18n[l])) {
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${l}.${k} vacia`);
    }
  }
});

test('html: data-i18n cubre las claves y todas existen en i18n.json', () => {
  const used = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]);
  assert.ok(used.length >= 45, `data-i18n usados: ${used.length}`);
  for (const k of used) assert.ok(i18n.es[k] !== undefined, `clave sin traduccion: ${k}`);
});

test('html: selector de idioma, svg animado y acordeon presentes', () => {
  assert.ok([...html.matchAll(/data-lang="(es|en|pt)"/g)].length >= 3);
  assert.ok(html.includes('<svg'));
  assert.ok(html.includes('@keyframes'));
  assert.ok(html.includes('prefers-reduced-motion'));
  assert.ok((html.match(/<details/g) || []).length >= 4);
});

test('html: autocontenido — sin scripts, estilos ni fonts externos', () => {
  assert.ok(!/<script[^>]+src=["']https?:/.test(html), 'script externo');
  assert.ok(!/<link[^>]+href=["']https?:/.test(html), 'link externo');
  assert.ok(!/@import\s+url\(["']?https?:/.test(html), 'css import externo');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|cdn\./.test(html), 'font/cdn externo');
});

test('html: comandos claves presentes y copiables', () => {
  assert.ok(html.includes('node rag-server.mjs'));
  assert.ok(html.includes('npx -y @rckflr/mcpwasm http://localhost:8937'));
  assert.ok(html.includes('navigator.clipboard'));
});