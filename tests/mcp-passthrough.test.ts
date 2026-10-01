import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createGraphServer } from "../src/server";

const store = { list: async () => [], get: async () => null, save: async () => {}, create: async () => ({}) as never };

describe("MCP pass-through", () => {
  const graph = createGraphServer({ store, ai: false, mcp: "parent" });

  it("registers prefixed graph tools on a host server", () => {
    const host = new McpServer({ name: "host", version: "1" });
    graph.registerMcpTools(host, { prefix: "shader_" });
    const names = Object.keys((host as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(names).toContain("shader_get_graph");
    expect(names).toContain("shader_disconnect");
    expect(names.every((n) => n.startsWith("shader_"))).toBe(true);
  });

  it("prefixes tool names in prose but not apply_operations op names", () => {
    const text = graph.mcpInstructions("shader_");
    expect(text).toContain("shader_list_projects / shader_create_project");
    expect(text).not.toMatch(/(^|[^_])get_graph/);
    const ops = graph.tools.find((t) => t.name === "apply_operations")!;
    expect(ops.description).toContain('{op:"disconnect"');
  });

  it("serves no MCP routes in parent mode", async () => {
    for (const url of ["/tsl-graph/mcp", "/tsl-graph/mcp/status"]) {
      expect(await graph.handle({ url, method: "POST", headers: {} } as never, {} as never)).toBe(false);
    }
  });
});
