# rag-local

Local-first RAG memory for LLMs. You keep the retrieval on your machine —
embeddings, a vector store, and OKF-structured chunks — and expose it to any
LLM via **REST + Web UI + CLI + MCP**. The external LLM only does generation;
it delegates retrieval to `rag-local`.

- **Production runtime** (`rag-node/`): a single Node server (`rag-server.mjs`)
  hosting the REST API, the admin Web UI, and the static MCP skills, on one port.
- **Shared engine** (`rag-poc/`): `rag-engine.mjs` + the OKF parser, the vendored
  `js-vector-store`, the CLI, and a **reference browser POC** running the same
  engine under LiteRT.js/WebGPU.
- **Browser runtime** (`rag-web/`): the same engine in a tab — embeddings via
  transformers.js, collections as `.jvsb` in a folder you pick with File System
  Access. Byte-compatible with `rag-node/collections/`, so you can index in Node
  and query in the browser. Optional Cloudflare Pages Functions expose that tab
  over **the same REST contract** as `rag-server.mjs`. See
  [rag-web/README.md](rag-web/README.md).

Node v24. MIT licensed.

## Architecture

```
                      ┌─────────────── rag-server.mjs  (port 8937) ───────────────┐
  LLM / agent  ──REST──▶  /collections/*        ┌─▶  RagEngine (rag-engine.mjs)
  CLI          ──REST──▶  /health               │     ├─ OKF parse + validate (okf.mjs)
  Web UI       ──HTTP──▶  /            ◀────────┤     ├─ embedFn (ONNX, 768-dim, L2-norm)
  MCP client   ──HTTP──▶  /llms.txt, /skills/*  │     └─ js-vector-store (QuantizedStore, Int8)
                      └──────────────────────────┘           │
   embedder-node.mjs : @huggingface/transformers              ▼
   onnx-community/embeddinggemma-300m-ONNX (q8)   collections/*.jvsb  (fs-persistence.mjs)
```

The LLM/CLI/UI/MCP client all hit the same REST surface. The server calls the
engine directly (no host queue, no polling). Embeddings come from
`onnx-community/embeddinggemma-300m-ONNX` quantized to `q8`, producing
768-dim L2-normalized vectors with asymmetric query/document prompts.

## Quickstart

```bash
cd rag-node
npm install
node rag-server.mjs
# → rag-server listening on 8937
# → UI at http://localhost:8937/
```

On first start the embedder downloads the public model
`onnx-community/embeddinggemma-300m-ONNX` (~316 MB, `q8`) into
`rag-node/models/`. The cache is kept outside `node_modules` so a clean
`npm install` won't force a re-download. Subsequent starts reuse the in-memory
singleton (Node startup ~1.5 s, measured vs ~50 s for the browser POC).

The server is stateless across restarts: collections persist as
`rag-node/collections/*.jvsb` bundle files.

### REST surface

| Method | Path                                  | Purpose                       |
|--------|---------------------------------------|-------------------------------|
| GET    | `/health`                             | liveness                      |
| GET    | `/collections`                        | list collection names         |
| POST   | `/collections`                        | create collection from docs (optional `contract`) |
| DELETE | `/collections/:name`                  | delete collection             |
| POST   | `/collections/:name/query`            | top-k retrieval (`threshold`, `expand_links`, `hops`) |
| GET    | `/collections/:name/export`           | export `.jvsb` bundle         |
| POST   | `/collections/:name/import`           | import `.jvsb` bundle         |
| GET    | `/` , `/ui/*`                         | admin Web UI                  |
| GET    | `/llms.txt`, `/skills/*`              | static MCP skill assets       |

## Deploy to Cloudflare Pages (browser + HTTP API)

**🌳 [Overview & guide (ES / EN / PT) →](https://mauricioperera.github.io/rag-local/cloudflare.html)** —
an illustrated walkthrough with a live device check.

This repo is also a **ready-to-deploy Cloudflare Pages template**. The same
engine runs entirely in a browser tab (embeddings via transformers.js, `.jvsb`
collections in a folder you pick), and Pages Functions relay HTTP requests to
that tab over **the same REST contract** as `rag-server.mjs`. Nothing runs on a
server; the free plan is enough.

```bash
git clone https://github.com/MauricioPerera/rag-local
cd rag-local && npm install

npx wrangler pages project create rag-local
npx wrangler pages secret put API_SECRET      # a secret you choose
npm run deploy                                # build.mjs assembles _site, then deploys
```

Or connect the repo in the dashboard: **Workers & Pages → Create → Pages →
Connect to Git**, build command `npm run build`, output directory `_site`, then
add `API_SECRET` and redeploy (a Pages secret only reaches deployments made
*after* it exists).

`build.mjs` copies the browser engine from `rag-poc/` into `_site/` and fixes
the relative paths — nothing third-party is vendored; the embedding model is
downloaded by the browser from Hugging Face on first use. `functions/api/`
mirrors the REST surface below. Open your `*.pages.dev`, pick a folder, load the
model, paste your `API_SECRET` into the **API worker** panel — while that tab is
open, the API is live. See [rag-web/README.md](rag-web/README.md) for details.

## CLI

The CLI (`rag-poc/rag-cli.mjs`) talks to the running server over REST. Run it
from `rag-poc/` or point at the server with `RAG_BRIDGE_PORT` (default `8937`).

```bash
cd rag-node && node rag-server.mjs        # in one terminal

# from the repo root, using the example OKF docs:
node rag-poc/rag-cli.mjs health
node rag-poc/rag-cli.mjs create my-col rag-poc/okf-docs.json
node rag-poc/rag-cli.mjs query my-col "how do vector databases retrieve documents" 5
node rag-poc/rag-cli.mjs export my-col my-col.jvsb
node rag-poc/rag-cli.mjs import my-col-copy my-col.jvsb
node rag-poc/rag-cli.mjs delete my-col
```

Full command list: `node rag-poc/rag-cli.mjs` (prints usage — `health`, `list`,
`create`, `query`, `export`, `import`, `delete`).

## MCP integration

The server hosts the MCP skills statically (`/llms.txt` + `/skills/*`). Wire
them into Claude Code with [`mcpwasm`](https://github.com/MauricioPerera/mcpwasm):

```bash
claude mcp add rag-local -- npx -y @rckflr/mcpwasm http://localhost:8937
```

Exposed skills: `rag_list_collections`, `rag_query`, `rag_create_collection`.

## OKF — Open Knowledge Format

Chunks are authored as OKF documents (frontmatter + body). On collection
creation the engine parses each doc and **validates before embedding anything**;
a single invalid doc aborts the whole batch (nothing is persisted).

Validator requirements:

- `type` — non-empty string
- `title` — string, length ≥ 3
- `description` — string, length > 10
- `tags` — array (inline `[a, b, c]` supported)
- `body` — free text after the closing `---`

### Knowledge contracts (per collection)

`POST /collections` accepts an optional `contract` that the engine enforces
deterministically on every doc — at creation and on later appends. Violations
reject the whole batch with named `kc-*` findings (same per-doc error format
as the base validator). The contract persists inside the `.jvsb` bundle
(`contract.json` entry), so it travels with export/import.

```json
{
  "name": "aurora",
  "contract": {
    "max_chars": 200,
    "forbid_relative": true,
    "forbidden_patterns": ["\bTBD\b"],
    "allowed_tags": ["aurora", "infra", "people", "process"],
    "min_links": 0
  },
  "docs": [ { "id": "f1", "md": "---
type: fact
..." } ]
}
```

- `max_chars` — cap on `description` length (0/absent = no cap)
- `forbid_relative` — rejects relative phrasings ("immediately after",
  "the next/previous/same", "N days before/after", "higher/lower than the")
  via the exported `RELATIVE_PATTERNS` set (`kc-relative`). Facts that need
  another entry to be resolved poison small consumers — state them absolutely.
- `forbidden_patterns` — additional custom regexes (`kc-pattern`)
- `allowed_tags` — closed tag vocabulary (`kc-tags`)
- `min_links` — minimum markdown links to other concept ids per doc (`kc-links`)

### Query options: threshold, link expansion, hops

`POST /collections/:name/query` accepts, besides `text` and `k`:

- `threshold` — score floor applied by the **engine** to the normal hits
  *before* expansion. This matters: a sub-threshold doc that is linked from a
  surviving hit is rescued by expansion instead of silently falling between
  engine-side dedup and client-side filtering.
- `expand_links: true` — docs markdown-linked (`[label](concept-id)`) from the
  surviving hits are appended to the result with `expanded: true`,
  `via: <parent id>`, `score: null`. Deduped globally; cycle-safe.
- `hops` — expansion depth (default 1, clamped to 3). With `hops: 2` a chain
  `stormdb -> vega -> R2 -> Quito` resolves fully from a single query.

Measured effect (1B consumer, 14-question multi-fact synthesis oracle):
realistic-retrieval synthesis went from **64% to 91%** with contract-modeled
facts + `threshold` + `hops: 2`; a 27B consumer reached **14/14** on the same
retrieval. Full evidence:
[evaluaciones-modelos-locales](https://github.com/MauricioPerera/evaluaciones-modelos-locales).

Example doc (from `rag-poc/okf-docs.json`):

```yaml
---
type: Nota técnica
title: Bases de Datos Vectoriales
description: Bases de datos vectoriales para busqueda semantica
tags: [bases de datos vectoriales, busqueda semantica, embeddings]
---

# Resumen

Las bases de datos vectoriales almacenan embeddings y permiten recuperar
documentos por similitud semantica, base del RAG.
```

The embedding text is composed from `title. description [tags: ...]`
(`composeEmbeddingText`), not the raw body. **Why:** measured against raw text,
OKF-structured text widened the top-1/top-2 score margin in **4/4 queries
(+0.033 average)**, i.e. it makes the right answer win by more.

OKF is a subset of the [Open Knowledge Format spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

## Browser POC (reference)

`rag-poc/` also ships a **reference browser variant** (`rag-bridge.mjs` +
`rag-host.html`, `app.js` + `index.html`) that runs the same `rag-engine.mjs`
under **LiteRT.js / WebGPU** instead of ONNX. It loads `embeddinggemma.tflite`
from a path outside the published tree (`../embed-demo/models/`, which is not
part of this repo).

That `.tflite` is **gated** and **not included**: fetch it with your own
HuggingFace account from
[`litert-community/embeddinggemma-300m`](https://huggingface.co/litert-community/embeddinggemma-300m)
and place it (plus `tokenizer.json`, `special_tokens_map.json`) where the POC
expects them. The Node/ONNX path above needs none of this.

Measured, ONNX `q8` (Node) vs LiteRT `.tflite` (browser): **top-1 identical
5/5**, average cosine agreement **0.966** — the two runtimes are retrieval-equivalent.

## Tests

Each directory has its own frozen suites (47+ tests across 9 suites):

```bash
cd rag-poc  && node --test *.test.mjs
cd rag-node && node --test *.test.mjs
```

Or a single suite: `cd rag-poc && node --test okf.test.mjs`.

## Credits / links

- [js-vector-store](https://github.com/MauricioPerera/js-vector-store) — backing vector store (`QuantizedStore`, Int8, `.jvsb` bundles)
- [mcpwasm](https://github.com/MauricioPerera/mcpwasm) — MCP-over-WASM client (`@rckflr/mcpwasm`)
- [OKF spec](https://github.com/GoogleCloudPlatform/knowledge-catalog) — Open Knowledge Format
- [EmbeddingGemma](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX) — `onnx-community/embeddinggemma-300m-ONNX`

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 Mauricio Perera.