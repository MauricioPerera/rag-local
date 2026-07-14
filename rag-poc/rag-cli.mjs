import { readFileSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.RAG_BRIDGE_PORT) || 8937;
const BASE = `http://localhost:${PORT}`;

function usage() {
  console.log(`Usage: node rag-cli.mjs <command> ...

  health
  list
  create <name> <docs.json>
  query <name> "<texto>" [k]
  export <name> <salida.jvsb>
  import <name> <entrada.jvsb>
  delete <name>`);
}

async function bodyJSON(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd) {
    usage();
    process.exitCode = 1;
    return;
  }

  try {
    switch (cmd) {
      case 'health': {
        const r = await fetch(`${BASE}/health`);
        console.log(JSON.stringify(await bodyJSON(r), null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      case 'list': {
        const r = await fetch(`${BASE}/collections`);
        console.log(JSON.stringify(await bodyJSON(r), null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      case 'create': {
        const [name, docsFile] = args;
        if (!name || !docsFile) {
          usage();
          process.exitCode = 1;
          return;
        }
        const docs = JSON.parse(readFileSync(docsFile, 'utf8'));
        const r = await fetch(`${BASE}/collections`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, docs }),
        });
        console.log(JSON.stringify(await bodyJSON(r), null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      case 'query': {
        const [name, text, k] = args;
        if (!name || text == null) {
          usage();
          process.exitCode = 1;
          return;
        }
        const body = { text };
        if (k != null) body.k = Number(k);
        const r = await fetch(`${BASE}/collections/${encodeURIComponent(name)}/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        console.log(JSON.stringify(await bodyJSON(r), null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      case 'export': {
        const [name, outFile] = args;
        if (!name || !outFile) {
          usage();
          process.exitCode = 1;
          return;
        }
        const r = await fetch(`${BASE}/collections/${encodeURIComponent(name)}/export`);
        if (!r.ok) {
          console.log(JSON.stringify(await bodyJSON(r), null, 2));
          process.exitCode = 1;
          return;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        writeFileSync(outFile, buf);
        console.log(`written ${buf.length} bytes to ${outFile}`);
        return;
      }
      case 'import': {
        const [name, inFile] = args;
        if (!name || !inFile) {
          usage();
          process.exitCode = 1;
          return;
        }
        const buf = readFileSync(inFile);
        const r = await fetch(`${BASE}/collections/${encodeURIComponent(name)}/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        console.log(JSON.stringify(await bodyJSON(r), null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      case 'delete': {
        const [name] = args;
        if (!name) {
          usage();
          process.exitCode = 1;
          return;
        }
        const r = await fetch(`${BASE}/collections/${encodeURIComponent(name)}`, {
          method: 'DELETE',
        });
        console.log(JSON.stringify(await bodyJSON(r), null, 2));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      default:
        usage();
        process.exitCode = 1;
        return;
    }
  } catch (e) {
    console.error(String(e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

main();