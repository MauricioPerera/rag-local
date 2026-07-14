# rag_create_collection

Creates a RAG collection with documents by calling `POST /collections` (body `{name, docs:[{id, md}]}`) via `host.fetchOrigin`. Returns `{name, count}`.

If the serialized body exceeds 15000 characters, the handler throws `body exceeds mcpwasm 16KB limit — use the CLI for large corpora` **before** calling the host, because the mcpwasm `host.fetchOrigin` body limit is 16KB. For large corpora use the rag CLI directly.

## Inputs

- `name` (string, required) — name of the collection to create.
- `docs` (array, required) — documents to index, each `{id, md}`.

## Example invocation

```json
{ "tool": "rag_create_collection", "args": { "name": "notes", "docs": [ { "id": "d1", "md": "# Hello\nWorld" } ] } }
```

## Note

Requires the **rag-host.html** page to be open in the browser — that page hosts the mcpwasm runtime and the same-origin bridge at `http://localhost:8937`. Without it, `host.fetchOrigin` has nothing to reach.