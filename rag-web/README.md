# rag-web — the engine in the browser, with an HTTP API

The same `rag-engine.mjs` that `rag-node/` runs, running entirely in a browser
tab: embeddings via transformers.js, collections as `.jvsb` files in **a folder
the user picks**. Optional Cloudflare Pages Functions turn that open tab into an
HTTP API speaking the **same REST contract as `rag-server.mjs`**.

Contents:

- `index.html` + `app.js` — the page. Wires the shared engine to the two
  browser-side dependencies and nothing else.
- `../functions/api/` — the Pages Functions (the API). Must stay at the repo
  root; see *Deploy*.

Nothing here reimplements the engine. `app.js` only injects what differs between
Node and browser:

| | Node (`rag-node/`) | browser (`rag-web/`) |
|---|---|---|
| `persistence` | `fsPersistence('./collections')` | `fsaPersistence(dirHandle)` |
| `embedFn` | `embedder-node.mjs` | `embedder-browser.mjs` |

Both persistence adapters write byte-identical `<name>.jvsb`, and both embedders
share `embedder-shared.mjs` (MODEL_ID + asymmetric prompts + L2 normalisation).
**Point the page at `rag-node/collections/` and you are working on the same
collections as the server** — index in Node, query in the browser, or the other
way round. `rag-poc/fsa-persistence.test.mjs` runs one contract against both
adapters and asserts exactly that.

## Run it

Locally, with the API (serves the page *and* the Functions on one origin):

```bash
wrangler pages dev . --port 8903 --binding API_SECRET=your-secret
# → http://localhost:8903/rag-web/
```

A plain static server (`python -m http.server`) also serves the page, but there
is no `/api` on that origin — the worker will say so instead of spinning.

Then, in the tab: **pick folder → load model → paste the secret**.

First model load is ~309 MB (`embeddinggemma-300m`, q8) from Hugging Face and
takes **~94 s**; cached afterwards, **~1.2 s**. A progress bar reports bytes per
file — without it, 94 s of silence reads as a hang.

**WebGPU is optional here.** transformers.js falls back to WASM, so this runs on
devices that cannot run a WebGPU LLM at all. `device` is selectable in the UI;
left alone, transformers.js decides.

## Deploy

`functions/` lives at the repo root and must stay there — copied inside the
output directory it is served as static files and every POST silently 405s.

```bash
wrangler pages project create rag-local --production-branch main
wrangler pages secret put API_SECRET        # then deploy; a secret only reaches
                                            # deployments created AFTER it
mkdir -p _site/rag-web _site/rag-poc
cp rag-web/index.html rag-web/app.js _site/rag-web/
cp rag-poc/{rag-engine,okf,fsa-persistence,embedder-browser,embedder-shared}.mjs    rag-poc/js-vector-store.js rag-poc/okf-docs.json _site/rag-poc/
wrangler pages deploy _site --project-name rag-local --branch main
```

165 KB total: the 309 MB model comes from Hugging Face, not from Pages (whose
per-asset limit is 25 MiB anyway). Live: <https://rag-local.pages.dev>.

On Windows, PowerShell's execution policy blocks npm's `wrangler.ps1` shim — call
`wrangler.cmd`.

## The API

Same paths and bodies as `rag-server.mjs`, under `/api`:

```bash
curl -X POST https://<project>.pages.dev/api/collections/ejemplo/query \
  -H "Authorization: Bearer $API_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"text":"diagnostico medico","k":3}'

[{"id":"ia-salud","score":0.366,"title":"Inteligencia Artificial en Salud",…}]
```

| Method | Path | |
|---|---|---|
| GET | `/api/collections` | list |
| POST | `/api/collections` | create `{name, docs:[{id,md}]}` |
| POST | `/api/collections/:name/docs` | append `{docs:[{id,md}]}` to an existing collection |
| PUT | `/api/collections/:name/docs/:id` | upsert one doc `{md}` (create or replace) |
| DELETE | `/api/collections/:name/docs/:id` | delete one doc (refuses the last one) |
| DELETE | `/api/collections/:name` | delete the whole collection |
| POST | `/api/collections/:name/query` | `{text, k}` |
| GET | `/api/collections/:name/export` | the raw `.jvsb` |
| POST | `/api/collections/:name/import` | body: the raw `.jvsb` |
| GET | `/api/status` | is a tab listening? is it armed? |
| GET | `/api/health` | liveness (unauthenticated) |

Every other route needs `Authorization: Bearer $API_SECRET`, not just the writes:
without it anyone who finds the URL could read your knowledge base, or poll
`/api/next` and see someone else's queries. It **fails closed** — with
`API_SECRET` unset every route returns 503.

```bash
wrangler pages secret put API_SECRET   # then REDEPLOY — see gotchas
```

### Why the tab polls instead of the Function pushing

A browser tab has no address and no listening socket: nothing can dial into it.
So it reaches out. Pages Functions are stateless, and the caller's request and
the tab's poll are two unrelated executions, so the job parks in the Workers
**Cache API** between them (`functions/api/_queue.js`) — no bindings, no D1, no
Durable Objects. The cache is per-colo, which is right here: caller and tab are
on the same machine.

```
POST /api/collections/x/query ─► Function ─► cache (pending)
                                              ▲ GET /api/next    (tab claims)
                                              │ POST /api/result (tab answers)
POST /api/collections/x/query ◄─ Function ◄───┘
```

The tab dispatches `op` through an **allowlist** (`OPS` in `app.js`) — mapping an
externally supplied `op` straight onto `engine[op]` would expose every method to
anyone with the secret.

**One job at a time**: one engine, one model. Everything else gets 429.

### export/import go around the JSON mailbox

A `.jvsb` is bytes. Putting it through the JSON queue means base64 — +33% and a
lot of CPU — and the Free plan allows **10 ms of CPU per invocation**. Measured:

| bundle | base64 + JSON.stringify | JSON.parse + decode |
|---|---|---|
| 1 MB | 1.7 ms | 1.2 ms |
| 5 MB | 7.1 ms | 5.6 ms |
| 20 MB | **33.5 ms** | 21.2 ms |

So that path tops out around 5 MB on Free — an artificial ceiling, since nothing
about the platform requires base64. `export`/`import` therefore use a separate
binary channel (`functions/api/blob.js`): raw `application/octet-stream`,
streamed straight into the Cache API as a binary `Response`. No base64, no
`JSON.parse`, no multi-MB spike in a 128 MB isolate. Verified byte-for-byte at 5
MB and 20 MB — the size that dies on the JSON path.

The other four routes stay on `_rpc`: they are small JSON and the backoff is
tuned for them. export/import are the exception, not the rule.

Measured bundle sizes (768-dim Int8 vectors + metadata + the `md` itself):

| | per doc | 1,000 docs | 10,000 docs |
|---|---|---|---|
| short docs (~135 B) | 1,236 B | 1.18 MB | ~12 MB |
| long docs (~1.7 KB) | 2,800 B | 2.67 MB | ~27 MB |

The real ceiling is now the request body limit — 100 MB on Free/Pro — i.e. tens
of thousands of documents. A personal knowledge base is orders of magnitude
below it.

## Limits and gotchas

- **The tab is the worker.** Close it and the API answers 503 (verified, ~15 s).
- **The folder permission dies on reload.** File System Access needs a human
  gesture to re-grant, so the worker must be armed by hand once per session. This
  cannot be automated the way a model load can.
- **Your queries and the retrieved chunks transit Cloudflare.** The vectors never
  leave your machine — but rag-local's whole premise is that retrieval stays
  local, and routing through the edge is a real dent in it. If everything that
  calls this lives on your machine anyway, `node rag-server.mjs` is strictly
  better: no queue, no polling, no edge, and a 1.5 s start.
- **`functions/` must stay at the repo root.** Copied into the output directory
  it is served as static files, routing silently falls back, and every POST 405s.
- **A Pages secret only reaches deployments created after it.** `secret list`
  will happily show it while the live Function still reports it unset. Redeploy
  after setting or rotating.
- **50 Cache-API calls per request** on the Workers Free plan, sharing the
  subrequest quota. That is why `_rpc.js` backs off exponentially (200 ms → 10 s,
  ~45 calls, ~6 min) instead of polling at a fixed interval — a fixed 400 ms poll
  exhausts the budget ~20 s in, so short queries would pass and long indexing
  runs would fail for no visible reason.
- **Do not turn the long-poll into a `setInterval`.** It is load-bearing twice: a
  1.5 s timer is 57,600 requests/day (58% of the Free plan's 100k, spent idle),
  and background tabs throttle timers to ~1/minute — the loop survives being
  minimised only because it advances on network events.
- **Model files cannot be served from Pages** (25 MiB per-asset limit); they come
  from Hugging Face.

## Verified

Against the real 309 MB model, a real folder, and `wrangler pages dev`:

| | |
|---|---|
| `GET /api/collections` | `["ejemplo"]`, 1.7 s |
| `POST /api/collections/ejemplo/query` | `ia-salud 0.366` — **identical to the UI**, 2.4 s |
| `POST /api/collections` (2 docs, embedded in-browser) | `{"name":"via-api","count":2}`, 2.4 s |
| query on the collection just created | `cafe 0.400` vs `te 0.170`, 2.4 s |
| `DELETE /api/collections/via-api` | 200, file gone from disk |
| no tab open | 503 in 15.5 s (does not hang) |
| no/!wrong secret | 401 · unset `API_SECRET` | 503 |
| disallowed `op` | rejected by the allowlist |

Engine-level coverage lives in `rag-poc/fsa-persistence.test.mjs` (18) and
`rag-poc/embedder-shared.test.mjs` (13), and `rag-node/embedder-node.test.mjs`
still passes against the real model after the shared-embedder refactor.

See the [root README](../README.md) for the architecture, the OKF format and the
Node runtime.
