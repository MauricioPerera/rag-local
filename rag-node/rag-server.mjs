// rag-server.mjs — servidor HTTP de producción para RagEngine.
// Replica EXACTO el contrato REST del bridge del POC (..\\rag-poc\\rag-bridge.mjs)
// pero llama al engine en forma DIRECTA: sin cola, sin polling de host, sin
// timeouts de host. Cada request espera el resultado del engine con await.
// Sin dependencias: solo node:http, node:fs, node:path, node:url.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Origins implícitamente permitidos: cualquier http(s) localhost/127.0.0.1,
// con puerto opcional.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Cabeceras CORS: hace echo del Origin cuando está presente (y permitido),
// o '*' cuando el request no trae Origin.
function corsHeaders(req) {
  const origin = req.headers.origin;
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// Content-Type para un archivo estático, por extensión.
function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.md' || ext === '.txt') return 'text/plain; charset=utf-8';
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

// True cuando `file` resuelve a `root` mismo o algún punto dentro de él.
function isInside(root, file) {
  const r = path.resolve(root);
  const f = path.resolve(file);
  return f === r || f.startsWith(r + path.sep);
}

export function startServer({
  port,
  engine,
  staticRoot = process.cwd(),
  allowedOrigins = [],
  maxBodyBytes = 64 * 1024 * 1024,
  uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'ui'),
} = {}) {
  const extraOrigins = new Set(allowedOrigins);

  function originAllowed(origin) {
    if (!origin) return true;
    if (LOCAL_ORIGIN.test(origin)) return true;
    return extraOrigins.has(origin);
  }

  const sockets = new Set();

  function sendJSON(res, status, obj, req) {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(body);
  }

  function sendStatus(res, status, req) {
    res.writeHead(status, corsHeaders(req));
    res.end();
  }

  // Sirve un archivo estático con CORS. 404 {error:'not found'} si falta.
  function serveFile(res, file, type, req) {
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      sendJSON(res, 404, { error: 'not found' }, req);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, ...corsHeaders(req) });
    res.end(data);
  }

  // Lee el body hasta maxBodyBytes. Si excede, corta la lectura y rechaza con
  // err.code === 'BODY_TOO_LARGE' (→ 413, destruyendo el request al flush).
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let finished = false;
      req.on('data', (c) => {
        if (finished) return;
        size += c.length;
        if (size > maxBodyBytes) {
          finished = true;
          const err = new Error('body too large');
          err.code = 'BODY_TOO_LARGE';
          reject(err);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!finished) resolve(Buffer.concat(chunks));
      });
      req.on('error', (e) => {
        if (!finished) {
          finished = true;
          reject(e);
        }
      });
    });
  }

  function bodyTooLarge(e) {
    return e && e.code === 'BODY_TOO_LARGE';
  }

  function sendTooLarge(res, req) {
    res.writeHead(413, { 'Content-Type': 'application/json', ...corsHeaders(req) });
    res.end(JSON.stringify({ error: 'body too large' }), () => req.destroy());
  }

  async function parseJSONBody(req) {
    const buf = await readBody(req);
    try {
      return JSON.parse(buf.toString('utf8') || '{}');
    } catch {
      throw new Error('invalid json');
    }
  }

  // Ejecuta `fn` (llamada directa al engine) y formatea la respuesta.
  // Errores del engine → 502 {error: mensaje}.
  async function handle(res, req, fn, formatter) {
    try {
      const result = await fn();
      formatter(result);
    } catch (err) {
      sendJSON(res, 502, { error: err && err.message ? err.message : String(err) }, req);
    }
  }

  const server = http.createServer(async (req, res) => {
    // CORS preflight: cualquier origin, siempre.
    if (req.method === 'OPTIONS') {
      sendStatus(res, 204, req);
      return;
    }

    // Validación de Origin aplicada a cada request antes que cualquier otra lógica.
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin not allowed' }));
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      sendJSON(res, 404, { error: 'not found' }, req);
      return;
    }
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);

    // ---- Health ----
    if (parts[0] === 'health' && parts.length === 1 && req.method === 'GET') {
      // hostConnected se conserva por compatibilidad, siempre true: ya no hay host remoto.
      sendJSON(res, 200, { ok: true, hostConnected: true }, req);
      return;
    }

    // ---- Archivos estáticos (skills MCP) ----
    if (req.method === 'GET' && parts[0] === 'llms.txt' && parts.length === 1) {
      const file = path.resolve(staticRoot, 'llms.txt');
      if (!isInside(staticRoot, file)) {
        sendJSON(res, 400, { error: 'bad path' }, req);
        return;
      }
      serveFile(res, file, 'text/plain; charset=utf-8', req);
      return;
    }
    if (req.method === 'GET' && parts[0] === 'skills') {
      const file = path.resolve(staticRoot, 'skills', ...parts.slice(1));
      if (!isInside(staticRoot, file)) {
        sendJSON(res, 400, { error: 'bad path' }, req);
        return;
      }
      serveFile(res, file, contentTypeFor(file), req);
      return;
    }

    // ---- UI de administración: GET / sirve index.html ----
    if (req.method === 'GET' && parts.length === 0) {
      const file = path.resolve(uiRoot, 'index.html');
      if (!isInside(uiRoot, file)) {
        sendJSON(res, 400, { error: 'bad path' }, req);
        return;
      }
      serveFile(res, file, 'text/html; charset=utf-8', req);
      return;
    }
    // ---- UI de administración: GET /ui/<resto> estático ----
    if (req.method === 'GET' && parts[0] === 'ui') {
      const file = path.resolve(uiRoot, ...parts.slice(1));
      if (!isInside(uiRoot, file)) {
        sendJSON(res, 400, { error: 'bad path' }, req);
        return;
      }
      serveFile(res, file, contentTypeFor(file), req);
      return;
    }

    // ---- Colecciones (lado cliente: LLM / CLI) ----
    if (parts[0] === 'collections') {
      if (parts.length === 1) {
        if (req.method === 'GET') {
          handle(res, req, () => engine.listCollections(), (result) =>
            sendJSON(res, 200, result, req),
          );
          return;
        }
        if (req.method === 'POST') {
          let body;
          try {
            body = await parseJSONBody(req);
          } catch (e) {
            if (bodyTooLarge(e)) sendTooLarge(res, req);
            else sendJSON(res, 400, { error: e.message }, req);
            return;
          }
          handle(res, req, () => engine.createCollection(body.name, body.docs), (result) =>
            sendJSON(res, 200, result, req),
          );
          return;
        }
        sendJSON(res, 404, { error: 'not found' }, req);
        return;
      }

      if (parts.length === 2) {
        const name = parts[1];
        if (req.method === 'DELETE') {
          handle(res, req, () => engine.deleteCollection(name), (result) =>
            sendJSON(res, 200, result, req),
          );
          return;
        }
        sendJSON(res, 404, { error: 'not found' }, req);
        return;
      }

      if (parts.length === 3) {
        const name = parts[1];
        if (parts[2] === 'query' && req.method === 'POST') {
          let body;
          try {
            body = await parseJSONBody(req);
          } catch (e) {
            if (bodyTooLarge(e)) sendTooLarge(res, req);
            else sendJSON(res, 400, { error: e.message }, req);
            return;
          }
          handle(res, req, () => engine.query(name, body.text, body.k), (result) =>
            sendJSON(res, 200, result, req),
          );
          return;
        }
        if (parts[2] === 'export' && req.method === 'GET') {
          handle(res, req, () => engine.exportBundle(name), (ab) => {
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              ...corsHeaders(req),
            });
            res.end(Buffer.from(ab));
          });
          return;
        }
        if (parts[2] === 'import' && req.method === 'POST') {
          let buf;
          try {
            buf = await readBody(req);
          } catch (e) {
            if (bodyTooLarge(e)) sendTooLarge(res, req);
            else sendJSON(res, 400, { error: e.message }, req);
            return;
          }
          // js-vector-store.unpackBundle exige un ArrayBuffer puro (crea un
          // DataView sobre él): extraer el slice exacto del Buffer leído.
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          handle(res, req, () => engine.importBundle(name, ab), (result) =>
            sendJSON(res, 200, result, req),
          );
          return;
        }
        sendJSON(res, 404, { error: 'not found' }, req);
        return;
      }

      sendJSON(res, 404, { error: 'not found' }, req);
      return;
    }

    sendJSON(res, 404, { error: 'not found' }, req);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.listen(port);

  const close = () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.close(() => resolve());
    });

  return { server, close };
}

// ---- Launcher directo (solo cuando se ejecuta como main) ----
// El import del embedder es LAZY (dynamic import dentro del isMain) para que
// los tests de este archivo no requieran que embedder-node.mjs exista.
const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const { createEmbedder } = await import('./embedder-node.mjs');
  const { RagEngine } = await import('../rag-poc/rag-engine.mjs');
  const { fsPersistence } = await import('./fs-persistence.mjs');

  const port = Number(process.env.RAG_PORT) || 8937;
  const { embedFn } = await createEmbedder();
  const engine = new RagEngine({
    embedFn,
    persistence: fsPersistence('./collections'),
    dim: 768,
  });
  const staticRoot = path.resolve(path.dirname(__filename), '..', 'rag-poc');
  const { server } = startServer({ port, engine, staticRoot });
  server.on('listening', () => console.log(`rag-server listening on ${port}`));
}