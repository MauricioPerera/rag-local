# rag-node — production runtime

Single Node server that hosts the REST API, the admin Web UI, and the static
MCP skills on one port (`8937`). Calls the shared `rag-engine.mjs` directly.

Contents:

- `rag-server.mjs` — HTTP server (REST + UI + static MCP), launcher that wires
  the embedder + engine + filesystem persistence.
- `embedder-node.mjs` — ONNX embedder (`onnx-community/embeddinggemma-300m-ONNX`,
  `q8`, 768-dim, asymmetric prompts, model cached in `models/`).
- `fs-persistence.mjs` — collections persisted as `collections/*.jvsb`.
- `ui/` — admin Web UI (`index.html`, `app.mjs`, `styles.css`).
- `package.json` — only `@huggingface/transformers`.

Start: `npm install && node rag-server.mjs` → UI at http://localhost:8937/.

See the [root README](../README.md) for the full architecture, REST surface,
MCP integration, and measured results.