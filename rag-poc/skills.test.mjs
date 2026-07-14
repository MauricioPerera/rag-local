import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const LLMS = readFileSync('./llms.txt', 'utf8');

function parseEntries() {
  const out = [];
  for (const line of LLMS.split('\n')) {
    const m = line.match(/^- \[([a-z0-9_]+)\]\(([^)]+)\).*<!-- skill: (\{.*\}) -->/);
    if (m) out.push({ name: m[1], skillMd: m[2], meta: JSON.parse(m[3]) });
  }
  return out;
}

test('llms.txt tiene al menos 3 skills con metadata valida', () => {
  const entries = parseEntries();
  assert.ok(entries.length >= 3, 'skills: ' + entries.length);
  const names = entries.map(e => e.name);
  assert.ok(names.includes('rag_list_collections'));
  assert.ok(names.includes('rag_query'));
  assert.ok(names.includes('rag_create_collection'));
  for (const e of entries) {
    assert.equal(e.meta.version, '1.0.0');
    assert.ok(e.meta.tool.startsWith('/skills/'));
    assert.match(e.meta.tool_sha256, /^[a-f0-9]{64}$/);
  }
});

test('cada tool_sha256 coincide con el archivo real', () => {
  for (const e of parseEntries()) {
    const content = readFileSync('.' + e.meta.tool, 'utf8');
    const sha = createHash('sha256').update(content).digest('hex');
    assert.equal(sha, e.meta.tool_sha256, e.name);
  }
});

test('cada tool.js registra su tool y usa solo host.fetchOrigin', () => {
  for (const e of parseEntries()) {
    const src = readFileSync('.' + e.meta.tool, 'utf8');
    assert.ok(src.includes('registerTool'), e.name);
    assert.ok(src.includes(`"${e.name}"`) || src.includes(`'${e.name}'`), e.name + ' name');
    assert.ok(!/\bfetch\s*\(/.test(src.replace(/host\.fetchOrigin/g, 'HF')), e.name + ' fetch prohibido');
    assert.ok(!src.includes('require('), e.name);
    assert.ok(!src.includes('import '), e.name);
  }
});

test('cada skill tiene SKILL.md', () => {
  for (const e of parseEntries()) {
    const md = readFileSync('.' + e.skillMd, 'utf8');
    assert.ok(md.length > 50, e.name);
  }
});

test('build-skill-hashes es idempotente', async () => {
  const before = readFileSync('./llms.txt', 'utf8');
  const { execSync } = await import('node:child_process');
  execSync('node build-skill-hashes.mjs');
  const after = readFileSync('./llms.txt', 'utf8');
  assert.equal(after, before);
});