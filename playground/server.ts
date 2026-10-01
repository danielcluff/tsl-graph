// Playground host: shows how a parent app embeds tsl-graph. The parent owns
// projects (here: JSON files + a tiny REST API), AI keys (here: env vars) and
// its own MCP server, which passes the graph tools through next to its own.
// The graph server adds the editor bridge and the AI chat loop.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ProjectDoc } from "../src/core/types";
import { createFileStore, createGraphServer, envApiKey } from "../src/server";

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? "127.0.0.1";
const PROD = process.env.NODE_ENV === "production";
const ROOT = resolve(import.meta.dirname, "..");

const store = createFileStore(join(process.env.TSL_DATA_DIR ?? join(ROOT, "data"), "projects"));

const graph = createGraphServer({
  store,
  basePath: "/tsl-graph",
  projectUrl: (id) => `http://localhost:${PORT}/#/p/${id}`,
  // the host decides where keys come from; the playground uses the usual env vars
  ai: { getApiKey: envApiKey },
  // the app's own /mcp serves the graph tools (see createAppMcpServer)
  mcp: "parent",
});

/** The parent app's MCP server: its own tools plus the graph tools under a "shader_" prefix. */
function createAppMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: "playground", version: "0.1.0" },
    { instructions: `This app has several sections; tools are prefixed by section.\n\n## Shaders (shader_*)\n${graph.mcpInstructions("shader_")}` },
  );
  mcp.registerTool("app_sections", { description: "List the sections of this app and their tool prefixes." }, async () => ({
    content: [{ type: "text", text: JSON.stringify([{ section: "shaders", prefix: "shader_" }]) }],
  }));
  graph.registerMcpTools(mcp, { prefix: "shader_" });
  return mcp;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
  // stateless: a fresh server/transport per request
  const mcp = createAppMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, await readBody(req));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The host app's own project API (not part of the package). */
async function handleProjects(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "projects", id?]
  if (parts[0] !== "api" || parts[1] !== "projects") return false;
  try {
    const id = parts[2];
    if (!id && req.method === "GET") return json(res, 200, await store.list()), true;
    if (!id && req.method === "POST") {
      const body = ((await readBody(req)) ?? {}) as { name?: string; from?: Partial<ProjectDoc> };
      return json(res, 201, await store.create(body.name, body.from)), true;
    }
    if (id && req.method === "GET") {
      const doc = await store.get(id);
      return doc ? json(res, 200, doc) : json(res, 404, { error: "Not found" }), true;
    }
    if (id && req.method === "PUT") {
      const doc = (await readBody(req)) as ProjectDoc;
      if (!doc || doc.id !== id) return json(res, 400, { error: "Body id mismatch" }), true;
      await store.save(doc);
      graph.notifyProjectChanged(id);
      return json(res, 200, { ok: true }), true;
    }
    if (id && req.method === "DELETE") return await store.remove(id), json(res, 200, { ok: true }), true;
    json(res, 404, { error: "Unknown endpoint" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

async function serveStatic(res: ServerResponse, url: URL) {
  const dist = join(ROOT, "dist");
  let file = join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    file = join(dist, "index.html");
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
}

const server = createServer();
graph.attach(server);

let vite: import("vite").ViteDevServer | undefined;
if (!PROD) {
  const { createServer: createVite } = await import("vite");
  vite = await createVite({ configFile: join(ROOT, "vite.config.ts"), server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
}

server.on("request", async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/mcp") return void handleMcp(req, res).catch((e) => json(res, 500, { error: String(e) }));
  if (await graph.handle(req, res)) return;
  if (await handleProjects(req, res, url)) return;
  if (vite) vite.middlewares(req, res);
  else await serveStatic(res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  TSL Graph playground  →  http://localhost:${PORT}`);
  console.log(`  MCP (HTTP)            →  http://localhost:${PORT}/mcp\n`);
});
