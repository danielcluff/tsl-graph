import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { INSTRUCTIONS, runTool, type ToolSpec } from "./tools";

export interface RegisterOptions {
  /** Prepended to every tool name (e.g. "shader_"), for parent servers that host tools from several sections. */
  prefix?: string;
  /** Called on every tool call (activity tracking). */
  onCall?: (server: McpServer) => void;
}

/**
 * Rewrite tool names mentioned in prose to their prefixed form. Only names
 * with an underscore are rewritten: "disconnect" is also an op name inside
 * apply_operations and must stay as-is there.
 */
export function prefixToolNames(text: string, tools: ToolSpec[], prefix = ""): string {
  if (!prefix) return text;
  const names = tools.map((t) => t.name).filter((n) => n.includes("_"));
  return text.replace(new RegExp(`\\b(${names.join("|")})\\b`, "g"), `${prefix}$1`);
}

/** MCP server instructions for the graph tools (with the same prefix as the tools). */
export function graphInstructions(tools: ToolSpec[], prefix = ""): string {
  return prefixToolNames(INSTRUCTIONS, tools, prefix);
}

/** Register the graph tools on an MCP server, which may be the parent application's own. */
export function registerGraphTools(server: McpServer, tools: ToolSpec[], opts: RegisterOptions = {}) {
  const prefix = opts.prefix ?? "";
  for (const tool of tools) {
    server.registerTool(
      `${prefix}${tool.name}`,
      { description: prefixToolNames(tool.description, tools, prefix), inputSchema: tool.shape },
      (args: Record<string, unknown>) => {
        opts.onCall?.(server);
        return runTool(tool, args);
      },
    );
  }
}

/** A standalone MCP server with only the graph tools (the built-in /mcp endpoint). */
export function createMcpServer(tools: ToolSpec[]): McpServer {
  const server = new McpServer({ name: "tsl-graph", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerGraphTools(server, tools);
  return server;
}
