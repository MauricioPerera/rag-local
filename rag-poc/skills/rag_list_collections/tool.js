registerTool({
  name: "rag_list_collections",
  description: "List all RAG collection names available on the local rag-bridge (GET /collections). Returns an array of name strings.",
  inputSchema: {
    type: "object",
    properties: {}
  },
  async handler() {
    var r = await host.fetchOrigin("/collections", {});
    if (r.status < 200 || r.status >= 300) {
      throw new Error("rag_list_collections failed: HTTP " + r.status + " " + r.body);
    }
    return JSON.parse(r.body);
  }
});