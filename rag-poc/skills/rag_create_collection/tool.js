registerTool({
  name: "rag_create_collection",
  description: "Create a RAG collection with documents (POST /collections, body {name, docs:[{id, md}]}). Returns {name, count}. Bodies larger than 15KB are rejected before calling the host; use the rag CLI for large corpora.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the collection to create." },
      docs: {
        type: "array",
        description: "Documents to index, each {id, md}.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable document id." },
            md: { type: "string", description: "Markdown text of the document." }
          }
        }
      }
    },
    required: ["name", "docs"]
  },
  async handler(args) {
    var body = JSON.stringify({ name: args.name, docs: args.docs });
    if (body.length > 15000) {
      throw new Error("body exceeds mcpwasm 16KB limit — use the CLI for large corpora");
    }
    var r = await host.fetchOrigin("/collections", {
      method: "POST",
      body: body,
      headers: { "content-type": "application/json" }
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error("rag_create_collection failed: HTTP " + r.status + " " + r.body);
    }
    return JSON.parse(r.body);
  }
});