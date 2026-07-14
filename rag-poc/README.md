# rag-poc — shared engine + reference POC

The shared RAG engine plus a reference browser POC. The same `rag-engine.mjs`
runs in Node (used by `rag-node/`) and in the browser (LiteRT.js/WebGPU).

Contents:

- `rag-engine.mjs` — motor RAG with OKF validation; backed by `js-vector-store.js`.
- `okf.mjs` — OKF parser (`parseOKF`, `composeEmbeddingText`).
- `js-vector-store.js` — vendored copy of [js-vector-store](https://github.com/MauricioPerera/js-vector-store).
- `rag-cli.mjs` — CLI over the server REST API.
- `rag-bridge.mjs` + `rag-host.html` / `rag-host.mjs` — browser/LiteRT.js variant.
- `app.js` + `index.html` — benchmark POC.
- `skills/` + `llms.txt` — static MCP skills served by `rag-node`.
- `okf-docs.json` — example OKF corpus. `*.test.mjs` — 9 frozen test suites.
- `models/` — (browser POC) expects the gated `.tflite` placed here; not included.

Tests: `node --test *.test.mjs`.

See the [root README](../README.md) for the full architecture, OKF format,
MCP integration, and the browser-POC model requirements.