# tsl-graph

The graph layer for TSL shader production: a node-based editor for [Three.js TSL](https://threejs.org/docs/#api/en/nodes/TSL)
shaders, an **MCP server** so agents can build shaders in an open editor, and an in-editor **AI chat** that uses the same
tools. It is meant to be embedded in a parent application, which owns projects and AI credentials.

## What lives where

| The package (tsl-graph)                                                                                              | The parent application                                   |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Graph editor UI, node registry, TSL compiler, live WebGPU preview                                                    | Project storage, listing, project browser, routing       |
| Per-device settings (localStorage): AI provider/model/effort, preview FPS, subgraph library, clipboard, chat history | AI API keys                                              |
| MCP endpoint, editor bridge, AI chat tool loop                                                                       | Accounts / auth (gate the graph server with `authorize`) |

## Entry points

| Import                 | Runs in  | What                                                                              |
| ---------------------- | -------- | --------------------------------------------------------------------------------- |
| `tsl-graph`            | anywhere | Core: types, `GraphHost`/`ProjectStore` contracts, templates, compiler, importers |
| `tsl-graph/editor`     | browser  | `<GraphEditor>` (Solid), `mountGraphEditor(el, props)` (any framework), `NodeCard` |
| `tsl-graph/ui`         | browser  | The UI kit the editor uses (Button, Dialog, Popover, …) and `setTheme`             |
| `tsl-graph/server`     | Node     | `createGraphServer()` (MCP + bridge + AI chat), `createFileStore()`                |
| `tsl-graph/styles.css` | browser  | Complete editor styles, Tailwind included                                          |
| `tsl-graph/editor.css` | browser  | Editor styles for hosts with their own Tailwind v4 build (see Styles)              |

## Embedding

### Browser: implement `GraphHost`

```ts
import { mountGraphEditor, type GraphHost } from "tsl-graph/editor";
import "tsl-graph/styles.css";

const host: GraphHost = {
    projects: {
        load: (id) => myApi.getProject(id),
        save: (doc) => myApi.saveProject(doc), // debounced autosave from the editor
        create: (name, from) => myApi.createProject(name, from), // tutorials, "remix"
    },
    openProject: (id) => router.push(`/shaders/${id}`), // tutorials, remix, MCP open_project
    exit: () => router.push("/shaders"), // logo in the top bar (optional)
    projectUrl: (id) => `${location.origin}/shaders/${id}`, // Share dialog (optional)
    server: { url: "/tsl-graph" }, // graph server; omit to run without MCP / AI chat
    mcp: "graph", // or "parent", see MCP below
    ai: { getApiKey: (provider) => myKeys[provider] }, // optional, see "AI keys"
};

const editor = mountGraphEditor(container, { host, projectId: "abc", theme: "dark" });
// switching projects: editor.dispose(); mountGraphEditor(container, { host, projectId: next });
```

In a Solid app use `<GraphEditor host={host} projectId={id} />` directly (key it on the id). Pass `doc` instead of
`projectId` for an in-memory project that is never saved. The editor fills its nearest positioned ancestor.

### Server: mount `createGraphServer`

```ts
import { createServer } from "node:http";
import { createGraphServer } from "tsl-graph/server";

const graph = createGraphServer({
    store, // ProjectStore: list / get / save / create — used by MCP when no editor tab is open
    basePath: "/tsl-graph", // same as GraphHost.server.url
    projectUrl: (id) => `https://my.app/shaders/${id}`,
    ai: { getApiKey: (provider, req) => keysFor(req, provider) },
    authorize: (req) => isSignedIn(req), // optional, gates MCP, bridge and chat
});

const server = createServer(async (req, res) => {
    if (await graph.handle(req, res)) return; // works with Express/Connect too
    app(req, res);
});
graph.attach(server); // WebSocket bridge to open editor tabs
```

When the host saves a project from somewhere other than the editor, call `graph.notifyProjectChanged(id)` so open
editor tabs reload it.

Routes (under `basePath`): `POST /mcp` and `GET /mcp/status` (only with `mcp: "graph"`), `WS /bridge`, `GET /ai/status`, `POST /ai/models`,
`POST /ai/chat`.

### AI keys

Keys never live in the package. Two ways to provide them; the first one that returns a key wins:

1. **Browser** — `GraphHost.ai.getApiKey(provider)`: the key is sent with each chat request to the graph server.
2. **Server** — `createGraphServer({ ai: { getApiKey(provider, req) } })`: keys stay on the server (recommended).
   Defaults to the usual env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) via `envApiKey`.

`ai.providers` limits the offered providers; `ai: false` disables chat.

### MCP

Who serves MCP to agents is set explicitly, with the same value on both sides: `createGraphServer({ mcp })` and
`GraphHost.mcp`.

| `mcp`               | Agents connect to                        | Editor UI                                                      |
| ------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `"graph"` (default) | the graph server's `<basePath>/mcp`      | "Connect agent (MCP)" menu item, dialog, Help tab, chat prompt |
| `"parent"`          | the host's own MCP server (pass-through) | none: the host decides how agents find its server              |

**Parent mode**, for apps whose MCP server covers several sections: register the graph tools on your server, optionally
prefixed:

```ts
const graph = createGraphServer({ store, mcp: "parent" });

function createAppMcpServer() {
    const mcp = new McpServer(
        { name: "my-app", version: "1.0.0" },
        { instructions: `…your app…\n\n## Shaders\n${graph.mcpInstructions("shader_")}` },
    );
    registerMyOtherSections(mcp);
    graph.registerMcpTools(mcp, { prefix: "shader_" }); // shader_get_graph, shader_add_node, …
    return mcp;
}
```

The prefix is also applied where tool descriptions and instructions mention other tools. Tool calls still reach open
editor tabs through the graph server's bridge, so `graph.attach(server)` is required in both modes. See
`playground/server.ts`.

In either mode, with a project open in an editor tab tool calls act on the live editor (undo history, live preview,
runtime errors, screenshots); otherwise they edit the stored document through the `ProjectStore`. For stdio-only
clients in graph mode: `TSL_GRAPH_URL=<mcp url> npx tsl-graph-mcp`.

## Playground

`playground/` is a minimal host app (hash routes, JSON-file store, REST API, AI keys from env or typed into the page, and
its own MCP server that passes the graph tools through as `shader_*`).

The canvas is [solid-graph](https://github.com/danielcluff/solid-graph), a git submodule in `packages/solid-graph`
(a pnpm workspace package): clone with `--recurse-submodules`, or run `git submodule update --init` in a checkout.

```bash
pnpm install
pnpm dev            # http://localhost:5173, the app's MCP at http://localhost:5173/mcp (graph tools as shader_*)
pnpm test
pnpm test:e2e       # canvas behaviour in headless Chromium (npx playwright-core install chromium once)
pnpm typecheck
```

`pnpm bench` measures the canvas (pan, zoom, drags, box select, wires, selection, add/remove) on generated projects of
70, 200 and 500 nodes against a running playground (`--url`, default http://localhost:5173), saving the results to
`bench/results/`; `--cpu 4` throttles the CPU, `pnpm bench --compare a.json b.json` compares two runs. The page it
drives is `playground/bench.html?n=200`; `npx tsx scripts/bench-profile.ts --scenarios dragAll` (or `--mount`) lists
the functions with the most self time.

Test the chat loop without keys: `PORT=5199 npx tsx scripts/mock-ai.ts`, then start the playground with
`ANTHROPIC_BASE_URL=http://127.0.0.1:5199 OPENAI_BASE_URL=http://127.0.0.1:5199/v1 GEMINI_BASE_URL=http://127.0.0.1:5199`
and enter any key on the playground page. `scripts/mcp-smoke.ts` drives a full agent session over MCP.

### Styles

Hosts without their own Tailwind build import `tsl-graph/styles.css`. Hosts that have one import the editor's part into
it, and add the editor's dark class to the `dark` variant:

```css
@import "tailwindcss";
@import "tsl-graph/editor.css";
@custom-variant dark (&:where(.dark, .dark *, .tsl-dark, .tsl-dark *));
```

The editor's tokens and base styles are scoped to `.tsl-graph-root`, so they don't touch the host page. If the host
uses `tsl-graph/ui` for its own pages, call `setTheme("dark" | "light")` so its dialogs and menus follow the site theme.
`GraphEditor` also takes a `theme` prop and a one-off `notice` (a toast once the project loads).

## Notes for consumers

- The package ships TypeScript/TSX source. The host bundler needs Solid's JSX transform (`@solidjs/vite-plugin`) and
  Tailwind v4 (`@tailwindcss/vite`) to process `styles.css`; the Node side needs a TS runtime (tsx) or a build step.
- `solid-js`, `@solidjs/web` and `three` are peer dependencies. The canvas comes from `solid-graph` (TSX source too);
  `tsl-graph/editor.css` imports its stylesheet.
- Keyboard shortcuts listen on `window` while the editor is mounted.

## Layout

```
src/core/      framework-free graph model, node registry, commands, TSL compiler, layout, templates, importers
src/runtime/   TSL evaluation scope + WebGPU preview renderer
src/editor/    Solid editor UI (GraphEditor, panels, AI chat client, bridge client)
src/ui/        UI kit + theme
src/server/    graph server: MCP, bridge, tool table (tools.ts, shared by MCP and chat), ai/ provider adapters
src/host.ts    the host contracts (GraphHost, ProjectStore)
playground/    example host app (also bench.html, e2e.html: the benchmark and canvas-test pages)
packages/      solid-graph (submodule): the canvas
tests/e2e/     canvas tests in headless Chromium
```
