// Node side of the graph package: MCP endpoint, the WebSocket bridge to open
// editor tabs, and the AI chat loop. Mount it in any Node HTTP server
// (plain http, Express, Connect, Vite middleware):
//
//   const graph = createGraphServer({ store, ai: { getApiKey } });
//   server.on("request", async (req, res) => { if (await graph.handle(req, res)) return; ...your app... });
//   graph.attach(server);
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpMode, ProjectStore, ProviderId } from "../host";
import { createChat, envApiKey, type ApiKeyResolver, type ChatRequest } from "./ai/index";
import { Bridge } from "./bridge";
import { createMcpServer, graphInstructions, registerGraphTools } from "./mcp";
import { McpActivity } from "./mcp-activity";
import { createTools, type ToolSpec } from "./tools";

export type { McpMode, ProjectStore, ProviderId } from "../host";
export { INSTRUCTIONS, runTool, type ToolResult, type ToolSpec } from "./tools";
export { registerGraphTools, graphInstructions } from "./mcp";
export { envApiKey, type ApiKeyResolver } from "./ai/index";

export interface GraphServerOptions {
  /** Where projects live. Used by MCP tools when no editor tab has the project open. */
  store: ProjectStore;
  /** URL prefix for every route below (default "/tsl-graph"). Pass the same value as GraphHost.server.url. */
  basePath?: string;
  /** Link to a project in the host app, included in MCP results (list_projects, create_project, …). */
  projectUrl?: (id: string) => string;
  /**
   * AI chat. `getApiKey` supplies provider keys per request (default: the
   * usual env vars). `providers` limits the offered providers. `false` turns
   * chat off.
   */
  ai?: false | { getApiKey?: ApiKeyResolver; providers?: ProviderId[] };
  /**
   * Who serves MCP to agents. Must match GraphHost.mcp in the browser.
   *  - "graph" (default): this server's `<basePath>/mcp` and `/mcp/status`.
   *  - "parent": the host's own MCP server passes the tools through
   *    (registerMcpTools); this server serves no MCP routes. The bridge to
   *    editor tabs works the same either way.
   */
  mcp?: McpMode;
  /** Gate every route (MCP, bridge, chat). Return false to answer 401. */
  authorize?: (req: IncomingMessage) => boolean | Promise<boolean>;
}

export interface GraphServer {
  /** Handle a request if it belongs to the graph server. Resolves false when it does not (pass it on). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Accept editor-tab WebSocket upgrades on an HTTP server. Other upgrades (e.g. Vite HMR) are left alone. */
  attach(server: Server): void;
  /** Tell open editor tabs that a project changed outside the editor (e.g. saved by another tab) so they reload it. */
  notifyProjectChanged(projectId: string): void;
  /**
   * MCP pass-through (`mcp: "parent"`): register the graph tools on the host's own MCP server
   * (call it wherever that server is created, e.g. per request when stateless).
   * Calls act on open editor tabs exactly like the built-in endpoint.
   */
  registerMcpTools(server: McpServer, opts?: { prefix?: string }): void;
  /** Usage notes for the graph tools, to merge into the host server's `instructions` (same prefix as the tools). */
  mcpInstructions(prefix?: string): string;
  /** Standalone MCP server with only the graph tools (other transports: stdio, in-process). */
  createMcpServer(): McpServer;
  tools: ToolSpec[];
  close(): void;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  // frameworks with a body parser (Express) have already consumed the stream
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined) return parsed;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createGraphServer(opts: GraphServerOptions): GraphServer {
  const base = (opts.basePath ?? "/tsl-graph").replace(/\/+$/, "");
  const mcpMode: McpMode = opts.mcp ?? "graph";
  const bridge = new Bridge();
  const activity = new McpActivity();
  const tools = createTools({ store: opts.store, bridge, projectUrl: opts.projectUrl });
  const chat = opts.ai === false ? null : createChat({ tools, getApiKey: opts.ai?.getApiKey ?? envApiKey, providers: opts.ai?.providers });
  const allowed = async (req: IncomingMessage) => !opts.authorize || (await opts.authorize(req));

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
    // Stateless: a fresh server/transport per request.
    const server = createMcpServer(tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const body = await readBody(req);
    activity.record(body);
    await transport.handleRequest(req, res, body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (!path.startsWith(`${base}/`)) return false;
    const route = path.slice(base.length);
    const known = [...(mcpMode === "graph" ? ["/mcp", "/mcp/status"] : []), "/ai/status", "/ai/models", "/ai/chat"];
    if (!known.includes(route)) return false;
    try {
      if (!(await allowed(req))) return json(res, 401, { error: "Unauthorized" }), true;
      if (route === "/mcp") await handleMcp(req, res);
      else if (route === "/mcp/status" && req.method === "GET") json(res, 200, activity.status());
      else if (!chat) json(res, 404, { error: "AI chat is disabled" });
      else if (route === "/ai/status" && req.method === "GET") json(res, 200, await chat.status(req));
      else if (route === "/ai/models" && req.method === "POST") await chat.models(req, res, ((await readBody(req)) ?? {}) as { provider?: ProviderId });
      else if (route === "/ai/chat" && req.method === "POST") await chat.chat(req, res, (await readBody(req)) as ChatRequest);
      else json(res, 405, { error: "Method not allowed" });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
    return true;
  }

  function attach(server: Server) {
    server.on("upgrade", async (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://x").pathname !== `${base}/bridge`) return;
      if (!(await allowed(req))) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      bridge.upgrade(req, socket, head);
    });
  }

  return {
    handle,
    attach,
    notifyProjectChanged: (projectId) => bridge.broadcast(projectId, { type: "saved", projectId }),
    registerMcpTools: (server, o) =>
      registerGraphTools(server, tools, {
        prefix: o?.prefix,
        onCall: (s) => activity.touch(s.server.getClientVersion()?.name),
      }),
    mcpInstructions: (prefix) => graphInstructions(tools, prefix),
    createMcpServer: () => createMcpServer(tools),
    tools,
    close: () => bridge.close(),
  };
}

export { createFileStore, type FileStore } from "./file-store";
