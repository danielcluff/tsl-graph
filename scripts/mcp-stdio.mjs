#!/usr/bin/env node
// stdio ⇄ HTTP proxy for MCP clients that only speak stdio. A graph server
// (createGraphServer) must be running; tool calls are forwarded to its /mcp
// endpoint. Set TSL_GRAPH_URL to that endpoint.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.TSL_GRAPH_URL ?? `http://localhost:${process.env.PORT ?? 5173}/tsl-graph/mcp`);

const stdio = new StdioServerTransport();
const http = new StreamableHTTPClientTransport(url);

stdio.onmessage = (msg) => {
  http.send(msg).catch((err) => {
    if (msg.id !== undefined) {
      void stdio.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: `TSL Graph server unreachable at ${url}: ${err instanceof Error ? err.message : err}` },
      });
    }
  });
};
http.onmessage = (msg) => void stdio.send(msg);
http.onerror = (err) => console.error("[tsl-graph-mcp]", err.message);
stdio.onclose = () => void http.close();

await http.start();
await stdio.start();
