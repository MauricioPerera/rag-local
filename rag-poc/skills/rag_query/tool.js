registerTool({
  name: "rag_query",
  description: "Query a RAG collection for the top-k most relevant chunks (POST /collections/<collection>/query). Returns the array of chunks [{id, score, title, type, tags, description, md}] as returned by the bridge.",
  inputSchema: {
    type: "object",
    properties: {
      collection: { type: "string", description: "Name of the collection to query." },
      text: { type: "string", description: "Query text to search for." },
      k: { type: "number", description: "Number of results to return (default 5).", default: 5 }
    },
    required: ["collection", "text"]
  },
  async handler(args) {
    var k = args.k;
    if (k === undefined || k === null) {
      k = 5;
    }
    var body = JSON.stringify({ text: args.text, k: k });
    var r = await host.fetchOrigin("/collections/" + encodeURIComponent(args.collection) + "/query", {
      method: "POST",
      body: body,
      headers: { "content-type": "application/json" }
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error("rag_query failed: HTTP " + r.status + " " + r.body);
    }
    return JSON.parse(r.body);
  }
});