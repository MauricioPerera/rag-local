# rag_query

Queries a RAG collection for the top-`k` most relevant chunks by calling `POST /collections/<collection>/query` via `host.fetchOrigin`. Returns the array of chunks `[{id, score, title, type, tags, description, md}]` exactly as returned by the bridge.

## Inputs

- `collection` (string, required) — name of the collection to query.
- `text` (string, required) — query text to search for.
- `k` (number, optional, default 5) — number of results to return.

## Example invocation

```json
{ "tool": "rag_query", "args": { "collection": "okf-demo", "text": "que es OKF", "k": 5 } }
```

## Note

Requires the **rag-host.html** page to be open in the browser — that page hosts the mcpwasm runtime and the same-origin bridge at `http://localhost:8937`. Without it, `host.fetchOrigin` has nothing to reach.