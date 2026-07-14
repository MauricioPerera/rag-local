import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOST_TIMEOUT_MS = 30000;
const HOST_STALE_MS = 5000;

// Origins implicitly allowed: any http(s) localhost/127.0.0.1, with optional port.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// CORS headers for a response, with Access-Control-Allow-Origin echoing the
// request Origin when present (and allowed), or '*' when absent.
function corsHeaders(req) {
  const origin = req.headers.origin;
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// Content-Type for a static skill file, by extension.
function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.md' || ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

// True when `file` resolves to `root` itself or somewhere inside it.
function isInside(root, file) {
  const r = path.resolve(root);
  const f = path.resolve(file);
  return f === r || f.startsWith(r + path.sep);
}

export function startBridge({
  port,
  staticRoot = process.cwd(),
  allowedOrigins = [],
  maxBodyBytes = 64 * 1024 * 1024,
  timeouts,
} = {}) {
  const extraOrigins = new Set(allowedOrigins);

  // Per-job timeout: timeouts[method] ?? timeouts.default ?? 30000.
  function timeoutFor(method) {
    return (timeouts && timeouts[method]) ?? (timeouts && timeouts.default) ?? HOST_TIMEOUT_MS;
  }

  function originAllowed(origin) {
    if (!origin) return true;
    if (LOCAL_ORIGIN.test(origin)) return true;
    return extraOrigins.has(origin);
  }

  const pending = [];     // FIFO queue of jobs awaiting the host
  const jobs = new Map(); // jobId -> job ({ jobId, method, params, resolve, reject, timer })
  let lastHostPoll = null;
  let counter = 0;

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

  // Serve a static file with CORS headers. 404 {error:'not found'} if missing.
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

  function hostConnected() {
    return lastHostPoll !== null && (Date.now() - lastHostPoll) <= HOST_STALE_MS;
  }

  // Enqueue a job and return a promise that resolves with the host result
  // (body.result) or rejects with { error } / { timeout, error }.
  function enqueueJob(method, params) {
    const jobId = String(++counter);
    return new Promise((resolve, reject) => {
      const job = { jobId, method, params, resolve, reject };
      job.timer = setTimeout(() => {
        if (!jobs.has(jobId)) return;
        jobs.delete(jobId);
        reject({ timeout: true, error: 'host timeout' });
      }, timeoutFor(method));
      jobs.set(jobId, job);
      pending.push(job);
    });
  }

  // Read the request body up to maxBodyBytes. Exceeding the limit stops the
  // read and rejects with err.code === 'BODY_TOO_LARGE' (→ 413 by the caller,
  // which then destroys the request once the response has been flushed).
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

  // 413 when the body exceeded maxBodyBytes; null otherwise.
  function bodyTooLarge(e) {
    return e && e.code === 'BODY_TOO_LARGE';
  }

  // 413 {error:'body too large'}; destroys the request once the response is
  // flushed so the upload is aborted without racing the 413 reply.
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

  // Run a job through the host and format the response via `formatter`.
  async function handleClient(res, req, method, params, formatter) {
    try {
      const result = await enqueueJob(method, params);
      formatter(result);
    } catch (err) {
      if (err && err.timeout) {
        sendJSON(res, 504, { error: 'host timeout' }, req);
      } else {
        sendJSON(res, 502, { error: err && err.error ? err.error : String(err) }, req);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    // CORS preflight: every origin, always.
    if (req.method === 'OPTIONS') {
      sendStatus(res, 204, req);
      return;
    }

    // Origin validation applied to every request before any other logic.
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

    // ---- Host side (the browser page) ----
    if (parts[0] === 'host') {
      if (parts[1] === 'poll' && req.method === 'GET') {
        lastHostPoll = Date.now();
        const job = pending.shift();
        if (job) {
          sendJSON(res, 200, { jobId: job.jobId, method: job.method, params: job.params }, req);
        } else {
          sendStatus(res, 204, req);
        }
        return;
      }
      if (parts[1] === 'result' && req.method === 'POST') {
        let body;
        try {
          body = await parseJSONBody(req);
        } catch (e) {
          if (bodyTooLarge(e)) sendTooLarge(res, req);
          else sendJSON(res, 400, { error: e.message }, req);
          return;
        }
        const job = jobs.get(body.jobId);
        if (!job) {
          sendJSON(res, 404, { error: 'unknown job' }, req);
          return;
        }
        clearTimeout(job.timer);
        jobs.delete(body.jobId);
        if (body.error != null) {
          job.reject({ error: body.error });
        } else {
          job.resolve(body.result);
        }
        sendJSON(res, 200, { ok: true }, req);
        return;
      }
      sendJSON(res, 404, { error: 'not found' }, req);
      return;
    }

    // ---- Health (no host required) ----
    if (parts[0] === 'health' && parts.length === 1 && req.method === 'GET') {
      sendJSON(res, 200, { ok: true, hostConnected: hostConnected() }, req);
      return;
    }

    // ---- Static files (skills MCP) ----
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

    // ---- Client side (LLM / CLI) ----
    if (parts[0] === 'collections') {
      if (!hostConnected()) {
        sendJSON(res, 503, { error: 'no browser host connected' }, req);
        return;
      }

      if (parts.length === 1) {
        if (req.method === 'GET') {
          handleClient(res, req, 'listCollections', {}, (result) => sendJSON(res, 200, result, req));
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
          handleClient(
            res,
            req,
            'createCollection',
            { name: body.name, docs: body.docs },
            (result) => sendJSON(res, 200, result, req),
          );
          return;
        }
        sendJSON(res, 404, { error: 'not found' }, req);
        return;
      }

      if (parts.length === 2) {
        const name = parts[1];
        if (req.method === 'DELETE') {
          handleClient(res, req, 'deleteCollection', { name }, (result) =>
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
          handleClient(
            res,
            req,
            'query',
            { name, text: body.text, k: body.k },
            (result) => sendJSON(res, 200, result, req),
          );
          return;
        }
        if (parts[2] === 'export' && req.method === 'GET') {
          handleClient(res, req, 'exportBundle', { name }, (result) => {
            const bin = Buffer.from((result && result.base64) || '', 'base64');
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...corsHeaders(req) });
            res.end(bin);
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
          const base64 = buf.toString('base64');
          handleClient(
            res,
            req,
            'importBundle',
            { name, base64 },
            (result) => sendJSON(res, 200, result, req),
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

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const port = Number(process.env.RAG_BRIDGE_PORT) || 8937;
  const { server } = startBridge({
    port,
    timeouts: { default: 30000, createCollection: 180000, importBundle: 180000 },
  });
  server.on('listening', () => console.log(`bridge listening on ${port}`));
}