import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

// Editor tabs connect here so MCP tools can act on the live editor (undo
// history, live preview, screenshots) instead of the stored document.

export interface BridgeClient {
  id: string;
  ws: WebSocket;
  projectId: string | null;
  lastActive: number;
  visible: boolean;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class Bridge {
  private clients = new Map<string, BridgeClient>();
  private pending = new Map<string, Pending>();
  private seq = 0;
  private wss = new WebSocketServer({ noServer: true });

  constructor() {
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  /** Complete a WebSocket upgrade for an editor tab. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  private onConnection(ws: WebSocket) {
    const client: BridgeClient = { id: `c${++this.seq}`, ws, projectId: null, lastActive: Date.now(), visible: true };
    this.clients.set(client.id, client);
    ws.on("message", (raw) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (msg.type) {
        case "hello":
        case "open":
          client.projectId = (msg.projectId as string) ?? null;
          client.lastActive = Date.now();
          break;
        case "active":
          client.lastActive = Date.now();
          client.visible = msg.visible !== false;
          break;
        case "result": {
          const p = this.pending.get(msg.id as string);
          if (!p) return;
          this.pending.delete(msg.id as string);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(String(msg.error ?? "Editor call failed")));
          break;
        }
      }
    });
    ws.on("close", () => this.clients.delete(client.id));
    ws.send(JSON.stringify({ type: "welcome", clientId: client.id }));
  }

  /** Most recently active editor tab showing `projectId`. */
  liveEditorFor(projectId: string): BridgeClient | undefined {
    let best: BridgeClient | undefined;
    for (const c of this.clients.values()) {
      if (c.projectId !== projectId || c.ws.readyState !== c.ws.OPEN) continue;
      if (!best || (c.visible && !best.visible) || (c.visible === best.visible && c.lastActive > best.lastActive)) best = c;
    }
    return best;
  }

  openEditors(): { clientId: string; projectId: string | null; visible: boolean }[] {
    return [...this.clients.values()].map((c) => ({ clientId: c.id, projectId: c.projectId, visible: c.visible }));
  }

  call<T = unknown>(client: BridgeClient, method: string, params: unknown, timeoutMs = 20000): Promise<T> {
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Editor did not respond to "${method}" within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      client.ws.send(JSON.stringify({ type: "call", id, method, params }));
    });
  }

  broadcast(projectId: string, message: object) {
    for (const c of this.clients.values()) {
      if (c.projectId === projectId && c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(message));
    }
  }

  /** Ask an editor tab to open another project (the tab hands this to its host). */
  navigate(clientId: string, projectId: string): boolean {
    const c = this.clients.get(clientId);
    if (!c || c.ws.readyState !== c.ws.OPEN) return false;
    c.ws.send(JSON.stringify({ type: "navigate", projectId }));
    c.projectId = projectId;
    c.lastActive = Date.now();
    return true;
  }

  close() {
    for (const c of this.clients.values()) c.ws.close();
    this.wss.close();
  }
}
