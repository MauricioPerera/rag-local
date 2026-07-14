# rag_list_collections

Lists every RAG collection name available on the local rag-bridge by calling `GET /collections` via `host.fetchOrigin`. Returns an array of name strings.

## Inputs

None.

## Example invocation

```json
{ "tool": "rag_list_collections", "args": {} }
```

## Note

Requires the **rag-host.html** page to be open in the browser — that page hosts the mcpwasm runtime and the same-origin bridge at `http://localhost:8937`. Without it, `host.fetchOrigin` has nothing to reach.