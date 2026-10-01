// MCP over stateless HTTP has no persistent connection, so "connected" means
// an MCP client has talked to this server recently.

const ACTIVE_MS = 30 * 60 * 1000;

export class McpActivity {
  private lastSeen = 0;
  private clientName: string | null = null;

  /** Record an incoming MCP JSON-RPC message (or batch). */
  record(body: unknown) {
    this.lastSeen = Date.now();
    for (const msg of Array.isArray(body) ? body : [body]) {
      const m = msg as { method?: string; params?: { clientInfo?: { name?: string } } } | null;
      if (m?.method === "initialize" && m.params?.clientInfo?.name) this.clientName = m.params.clientInfo.name;
    }
  }

  /** A tool call arrived through a parent MCP server (pass-through). */
  touch(clientName?: string | null) {
    this.lastSeen = Date.now();
    if (clientName) this.clientName = clientName;
  }

  status() {
    const connected = this.lastSeen > 0 && Date.now() - this.lastSeen < ACTIVE_MS;
    return { connected, client: connected ? this.clientName : null, lastSeen: this.lastSeen || null };
  }
}
