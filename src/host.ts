// The contract between the graph package and the application embedding it.
//
// The parent application owns projects (storage, listing, routing) and AI
// credentials. The graph package owns the editor, its per-device settings
// (stored in localStorage) and the MCP / AI-chat tool loop.
//
// Two halves:
//  - GraphHost   (browser) is passed to the editor when it is mounted.
//  - ProjectStore + GraphServerOptions (Node) are passed to createGraphServer.

import type { JSX } from "@solidjs/web";
import type { Camera, Scene, WebGPURenderer } from "three/webgpu";
import type { ProjectDoc, ProjectSummary } from "./core/types";

export type { ProjectDoc, ProjectSummary } from "./core/types";

export type ProviderId = "anthropic" | "openai" | "google";
export type McpMode = "graph" | "parent";
export const PROVIDER_IDS: ProviderId[] = ["anthropic", "openai", "google"];

// ---------------------------------------------------------------------------
// browser
// ---------------------------------------------------------------------------

/** A host's post-processing stack, built for one preview renderer. */
export interface HostPostStack {
  /** Whether it should replace the preview's direct render right now. */
  readonly enabled: boolean;
  /** Render the scene through the stack to the canvas. */
  render(): void;
  /** Called when its settings change, so an on-demand preview redraws. */
  onChange(fn: () => void): () => void;
  dispose(): void;
}

/** Project persistence as seen from the editor. */
export interface ProjectSource {
  load(id: string): Promise<ProjectDoc>;
  save(doc: ProjectDoc): Promise<void>;
  /** Create a new project (tutorials, "remix"). Return the stored document with its id. */
  create(name: string, from?: Partial<ProjectDoc>): Promise<ProjectDoc>;
}

export interface GraphHost {
  projects: ProjectSource;
  /** Show another project. The host owns routing, so it decides how (navigate, swap the mounted id, …). */
  openProject(id: string): void;
  /** Called by the logo in the top bar. Omit to make the logo inert. */
  exit?(): void;
  /** Shareable link for a project. Omit to hide the link in the Share dialog. */
  projectUrl?(id: string): string;
  /** Link to the node reference docs (Help menu). Omit to hide the menu item. */
  docsUrl?: string;
  /**
   * Graph server (see createGraphServer) that provides the MCP bridge and the
   * AI chat loop. `url` is its base path, absolute or relative to the page
   * (e.g. "/tsl-graph"). Omit to run the editor without MCP and AI chat.
   */
  server?: {
    url: string;
    /** Extra headers for chat requests (auth). The bridge WebSocket relies on cookies. */
    headers?: () => Record<string, string> | Promise<Record<string, string>>;
  };
  /**
   * Who serves MCP to agents. Must match createGraphServer's `mcp` option.
   *  - "graph" (default): the graph server's own `<server.url>/mcp`; the
   *    editor shows how to connect an agent to it.
   *  - "parent": the host's MCP server passes the graph tools through
   *    (GraphServer.registerMcpTools); the editor shows no connect-agent UI.
   */
  mcp?: McpMode;
  /**
   * AI chat credentials. A key returned here is sent with each chat request
   * to the graph server; when it returns nothing the server's own
   * `ai.getApiKey` is used instead.
   */
  ai?: {
    getApiKey?(provider: ProviderId): string | undefined | null | Promise<string | undefined | null>;
  };
  /**
   * Post-processing the host applies to the main preview (e.g. one look shared
   * with its other viewports). A project's own post graph takes precedence
   * when it is enabled and has effects in it; otherwise this stack is used.
   */
  previewPost?: {
    create(renderer: WebGPURenderer, scene: Scene, camera: Camera): HostPostStack;
    /** Controls shown from the preview's toolbar. Omit to show none. */
    controls?: () => JSX.Element;
  };
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

/** Project persistence for MCP tools that run while no editor tab has the project open. */
export interface ProjectStore {
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<ProjectDoc | null>;
  save(doc: ProjectDoc): Promise<void>;
  create(name?: string, from?: Partial<ProjectDoc>): Promise<ProjectDoc>;
}
