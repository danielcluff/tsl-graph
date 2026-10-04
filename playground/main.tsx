// Playground host app. Everything here is what a parent application provides:
// routing, the project browser, project storage (a REST API) and AI keys.
import { For, Show, createSignal } from "solid-js";
import { render } from "@solidjs/web";
import { GraphEditor, type GraphHost, type ProviderId } from "../src/editor";
import { PROVIDER_IDS, TEMPLATES, importTslGraph, isTslGraphExport, projectFromTemplate, type ProjectDoc, type ProjectSummary } from "../src";
import "./styles.css";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${method} ${url} failed`);
  return res.json() as Promise<T>;
}

const projects = {
  list: () => req<ProjectSummary[]>("GET", "/api/projects"),
  load: (id: string) => req<ProjectDoc>("GET", `/api/projects/${id}`),
  save: (doc: ProjectDoc) => req<void>("PUT", `/api/projects/${doc.id}`, doc),
  create: (name: string, from?: Partial<ProjectDoc>) => req<ProjectDoc>("POST", "/api/projects", { name, from }),
  remove: (id: string) => req<void>("DELETE", `/api/projects/${id}`),
};

// ---- routing: #/ (projects) and #/p/:id (editor) ---------------------------
const [route, setRoute] = createSignal(location.hash);
window.addEventListener("hashchange", () => setRoute(location.hash));
const go = (hash: string) => (location.hash = hash);
const projectId = () => /^#\/p\/([\w-]+)/.exec(route())?.[1];

// Keys typed on the project page; a real host would fetch them from its own
// account system or keep them server-side (createGraphServer's ai.getApiKey).
const keyName = (p: ProviderId) => `playground-ai-key-${p}`;

const host: GraphHost = {
  projects,
  openProject: (id) => go(`#/p/${id}`),
  exit: () => go("#/"),
  projectUrl: (id) => `${location.origin}/#/p/${id}`,
  server: { url: "/tsl-graph" },
  mcp: "parent",
  ai: { getApiKey: (p) => sessionStorage.getItem(keyName(p)) },
};

function App() {
  return (
    <Show when={projectId()} keyed fallback={<ProjectList />}>
      {(id) => (
        <div style={{ position: "fixed", inset: 0 }}>
          <GraphEditor host={host} projectId={id} />
        </div>
      )}
    </Show>
  );
}

function ProjectList() {
  const [list, setList] = createSignal<ProjectSummary[]>([]);
  const refresh = () => projects.list().then(setList);
  void refresh();

  const create = async (doc: ProjectDoc) => go(`#/p/${(await projects.create(doc.name, doc)).id}`);
  const importFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const json = JSON.parse(await file.text());
      await create(isTslGraphExport(json) ? importTslGraph(json, file.name.replace(/\.json$/, "")).doc : (json as ProjectDoc));
    };
    input.click();
  };

  return (
    <div class="tsl-graph-root tsl-dark min-h-full bg-background p-8 text-foreground">
      <div class="mx-auto max-w-4xl space-y-8">
        <div>
          <h1 class="text-2xl font-bold">TSL Graph playground</h1>
          <p class="text-sm text-muted-foreground">A minimal host app: it owns the project list, storage and AI keys.</p>
        </div>

        <section class="space-y-2">
          <h2 class="text-sm font-semibold">New project</h2>
          <div class="flex flex-wrap gap-2">
            <For each={TEMPLATES}>
              {(t) => (
                <button type="button" class="rounded-md border px-3 py-1.5 text-sm hover:bg-accent" onClick={() => create(projectFromTemplate(t.id))}>
                  {t.name}
                </button>
              )}
            </For>
            <button type="button" class="rounded-md border border-dashed px-3 py-1.5 text-sm hover:bg-accent" onClick={importFile}>
              Import JSON…
            </button>
          </div>
        </section>

        <section class="space-y-2">
          <h2 class="text-sm font-semibold">Projects</h2>
          <Show when={list().length} fallback={<p class="text-sm text-muted-foreground">No projects yet.</p>}>
            <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
              <For each={list()}>
                {(p) => (
                  <div class="group overflow-hidden rounded-lg border bg-card">
                    <a href={`#/p/${p.id}`} class="block">
                      <div class="aspect-video bg-muted">
                        <Show when={p.thumbnail}>{(src) => <img src={src()} alt="" class="size-full object-cover" />}</Show>
                      </div>
                      <div class="px-3 py-2 text-sm font-medium">{p.name}</div>
                    </a>
                    <div class="flex justify-between px-3 pb-2 text-xs text-muted-foreground">
                      <span>
                        {p.nodeCount} nodes{p.kind === "particle" ? " · particle shader" : ""}
                      </span>
                      <button
                        type="button"
                        class="hover:text-destructive"
                        onClick={async () => {
                          if (confirm(`Delete "${p.name}"?`)) await projects.remove(p.id).then(refresh);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>

        <section class="space-y-2">
          <h2 class="text-sm font-semibold">AI keys (passed to the editor by this host)</h2>
          <p class="text-xs text-muted-foreground">Kept in this tab's sessionStorage. Leave empty to use the server's env vars.</p>
          <For each={PROVIDER_IDS}>
            {(p) => (
              <label class="flex items-center gap-2 text-sm">
                <span class="w-24 capitalize">{p}</span>
                <input
                  type="password"
                  autocomplete="off"
                  class="h-8 flex-1 rounded-md border bg-transparent px-2"
                  value={sessionStorage.getItem(keyName(p)) ?? ""}
                  onChange={(e) => {
                    const v = e.currentTarget.value.trim();
                    if (v) sessionStorage.setItem(keyName(p), v);
                    else sessionStorage.removeItem(keyName(p));
                  }}
                />
              </label>
            )}
          </For>
        </section>
      </div>
    </div>
  );
}

render(() => <App />, document.getElementById("root")!);
