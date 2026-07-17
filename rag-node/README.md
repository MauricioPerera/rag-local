# rag-node — production runtime

Single Node server that hosts the REST API, the admin Web UI, and the static
MCP skills on one port (`8937`). Calls the shared `rag-engine.mjs` directly.

Contents:

- `rag-server.mjs` — HTTP server (REST + UI + static MCP), launcher that wires
  the embedder + engine + filesystem persistence.
- `embedder-node.mjs` — ONNX embedder (`onnx-community/embeddinggemma-300m-ONNX`,
  `q8`, 768-dim, model cached in `models/`). MODEL_ID, prompts and normalisation
  come from `../rag-poc/embedder-shared.mjs`, shared with the browser embedder so
  the two cannot drift apart and silently break collection interop.
- `fs-persistence.mjs` — collections persisted as `collections/*.jvsb`. Same bytes
  as `../rag-poc/fsa-persistence.mjs`, so `rag-web/` can share this folder.
- `ui/` — admin Web UI (`index.html`, `app.mjs`, `styles.css`).
- `package.json` — only `@huggingface/transformers`.

Start: `npm install && node rag-server.mjs` → UI at http://localhost:8937/.

See the [root README](../README.md) for the full architecture, REST surface,
MCP integration, and measured results.