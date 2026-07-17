# rag-poc — shared engine + reference POC

The shared RAG engine plus a reference browser POC. The same `rag-engine.mjs`
runs in Node (used by `rag-node/`) and in the browser (LiteRT.js/WebGPU).

Contents:

- `rag-engine.mjs` — motor RAG with OKF validation; backed by `js-vector-store.js`.
- `embedder-shared.mjs` — MODEL_ID + asymmetric prompts + L2 norm. **What defines
  the vector**, shared by the Node and browser embedders so they cannot drift: a
  changed prefix on one side alone would silently make collections incompatible.
- `embedder-browser.mjs` — browser twin of `rag-node/embedder-node.mjs`
  (transformers.js from CDN, no cacheDir, optional `device`, WASM fallback).
- `fsa-persistence.mjs` — File System Access adapter: `.jvsb` in a folder the
  user picks, byte-identical to `fs-persistence.mjs`.
- `okf.mjs` — OKF parser (`parseOKF`, `composeEmbeddingText`).
- `js-vector-store.js` — vendored copy of [js-vector-store](https://github.com/MauricioPerera/js-vector-store).
- `rag-cli.mjs` — CLI over the server REST API.
- `rag-bridge.mjs` + `rag-host.html` / `rag-host.mjs` — browser/LiteRT.js variant.
- `app.js` + `index.html` — benchmark POC.
- `skills/` + `llms.txt` — static MCP skills served by `rag-node`.
- `okf-docs.json` — example OKF corpus (also what `rag-web` offers as a one-click
  starter collection). `*.test.mjs` — frozen test suites.
- `models/` — (browser POC) expects the gated `.tflite` placed here; not included.

Tests: `node --test *.test.mjs`.

See the [root README](../README.md) for the full architecture, OKF format,
MCP integration, and the browser-POC model requirements.