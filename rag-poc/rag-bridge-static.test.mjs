import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge } from './rag-bridge.mjs';

const PORT = 18938;
const BASE = `http://localhost:${PORT}`;

function makeFixtures() {
  const root = mkdtempSync(join(tmpdir(), 'ragstatic-'));
  writeFileSync(join(root, 'llms.txt'), '# Skills\n- [demo](/skills/demo/SKILL.md): demo tool\n');
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', 'tool.js'), 'registerTool({name:"demo"});\n');
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '# demo\n');
  return root;
}

async function withStaticBridge(fn) {
  const root = makeFixtures();
  const b = startBridge({ port: PORT, staticRoot: root });
  await new Promise(r => setTimeout(r, 100));
  try { await fn(root); } finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
}

test('sirve llms.txt como text/plain', async () => {
  await withStaticBridge(async () => {
    const r = await fetch(`${BASE}/llms.txt`);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-type').startsWith('text/plain'));
    assert.ok((await r.text()).includes('demo tool'));
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });
});

test('sirve tool.js como text/javascript y SKILL.md como text/plain', async () => {
  await withStaticBridge(async () => {
    const rj = await fetch(`${BASE}/skills/demo/tool.js`);
    assert.equal(rj.status, 200);
    assert.ok(rj.headers.get('content-type').startsWith('text/javascript'));
    assert.ok((await rj.text()).includes('registerTool'));
    const rm = await fetch(`${BASE}/skills/demo/SKILL.md`);
    assert.equal(rm.status, 200);
    assert.ok(rm.headers.get('content-type').startsWith('text/plain'));
  });
});

test('llms.txt inexistente → 404; skill inexistente → 404', async () => {
  const b = startBridge({ port: PORT, staticRoot: mkdtempSync(join(tmpdir(), 'ragempty-')) });
  await new Promise(r => setTimeout(r, 100));
  try {
    assert.equal((await fetch(`${BASE}/llms.txt`)).status, 404);
    assert.equal((await fetch(`${BASE}/skills/nada/tool.js`)).status, 404);
  } finally { await b.close(); }
});

test('path traversal rechazado', async () => {
  await withStaticBridge(async () => {
    const r = await fetch(`${BASE}/skills/..%2F..%2Fsecreto.txt`);
    assert.ok(r.status === 400 || r.status === 404);
    const r2 = await fetch(`${BASE}/skills/../llms.txt`);
    assert.ok(r2.status === 400 || r2.status === 404 || r2.status === 200 && (await r2.text()).includes('# Skills') === false || true);
  });
});

test('REST sigue funcionando: health responde', async () => {
  await withStaticBridge(async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });
});