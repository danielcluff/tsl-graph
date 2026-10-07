import { Show, createRenderEffect, createSignal, onSettled, snapshot, untrack, useContext } from "solid-js";
import { importTslGraph, isTslGraphExport, summarizeImport } from "../core/import-tslgraph";
import type { ProjectDoc } from "../core/types";
import type { GraphHost } from "../host";
import { rootClass, setTheme, type Theme } from "../ui/theme";
import { Canvas } from "./Canvas";
import { ContextMenu, FindBar, Toasts, TopBar, Toolbar } from "./Chrome";
import { Dialogs } from "./Dialogs";
import { Inspector } from "./Inspector";
import { NodePicker } from "./NodePicker";
import { PreviewPanel } from "./PreviewPanel";
import { Sidebar } from "./Sidebar";
import { connectBridge } from "./bridge-client";
import { HostContext } from "./host";
import { installShortcuts } from "./shortcuts";
import { EditorContext, createEditor, loadLibrary } from "./store";
import { AIChat } from "./AIChat";
import { ChatContext, createChat } from "./ai-chat";
import { ui } from "./ui-state";

export interface GraphEditorProps {
  host: GraphHost;
  /** Project to load through `host.projects.load`. Changes are saved back through `host.projects.save`. */
  projectId?: string;
  /** Or: an in-memory document that is edited but never saved (demos, previews). */
  doc?: ProjectDoc;
  theme?: Theme;
  /** Hide the export/share controls in the top bar (for embedded views). */
  embed?: boolean;
  /** A message to show (as a toast) once the project has loaded, e.g. an import summary. */
  notice?: { message: string; kind?: "info" | "error" | "success" };
}

/**
 * The full graph editor. It fills its nearest positioned ancestor, so give
 * the container a size (and `position: relative`).
 */
export function GraphEditor(props: GraphEditorProps) {
  const [doc, setDoc] = createSignal<ProjectDoc | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  createRenderEffect(
    () => props.theme ?? "dark",
    (t) => void setTheme(t),
  );

  onSettled(() => {
    const given = untrack(() => props.doc);
    if (given) return void setDoc(structuredClone(given));
    const id = untrack(() => props.projectId);
    if (!id) return void setError("No project given");
    untrack(() => props.host)
      .projects.load(id)
      .then(setDoc)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  });

  return (
    <HostContext value={untrack(() => props.host)}>
      <div class={`${rootClass()} absolute inset-0 overflow-hidden bg-background text-foreground`}>
        <Show
          when={doc()}
          keyed
          fallback={
            <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
              {error() ? <div class="text-destructive">{error()}</div> : "Loading project…"}
            </div>
          }
        >
          {(d) => (
            <EditorShell doc={d} persist={!untrack(() => props.doc)} embed={!!untrack(() => props.embed)} notice={untrack(() => props.notice)} />
          )}
        </Show>
      </div>
    </HostContext>
  );
}

function EditorShell(props: { doc: ProjectDoc; persist: boolean; embed: boolean; notice?: GraphEditorProps["notice"] }) {
  const host = useContext(HostContext);
  const ed = createEditor(untrack(() => props.doc), { save: untrack(() => props.persist) ? (doc) => host.projects.save(doc) : undefined, load: untrack(() => props.persist) ? () => host.projects.load(props.doc.id) : undefined });
  const chat = createChat(ed, host);
  if (import.meta.env?.DEV) (window as unknown as { __tsl: unknown }).__tsl = { ed, ui, chat };
  ui.insertSubgraphById = (id, at) => {
    const def = ed.state.doc.customNodes.find((s) => s.id === id) ?? loadLibrary().find((s) => s.id === id);
    if (def) ed.insertSubgraph(def, at);
  };

  onSettled(() => {
    ed.compileNow();
    const notice = untrack(() => props.notice);
    if (notice) setTimeout(() => ui.toast(notice.message, notice.kind ?? "info"), 600);
    const offKeys = installShortcuts(ed, () =>
      chat.setState((d) => {
        d.open = !(d.open && !d.minimized);
        d.minimized = false;
      }),
    );
    const offBridge = untrack(() => props.persist) ? connectBridge(ed, host) : () => {};
    const onFocus = () => { void ed.checkForUpdates(); };
    const onVisibility = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (ed.state.saveState !== "saved") {
        void ed.save();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);

    // automatic thumbnails: at most every 15s, only after content changes
    let lastThumbVersion = -1;
    const thumbTimer = window.setInterval(async () => {
      if (!untrack(() => props.persist) || ed.state.externalConflict || document.visibilityState !== "visible" || ed.state.doc.settings.thumbnail !== "auto") return;
      const v = ed.version();
      if (v === lastThumbVersion || !ed.previewHooks.thumbnail) return;
      lastThumbVersion = v;
      try {
        const t = await ed.previewHooks.thumbnail();
        ed.mutate((doc) => void (doc.thumbnail = t), { history: false, recompile: false });
        lastThumbVersion = ed.version();
      } catch {
        // ignore
      }
    }, 15000);

    return () => {
      offKeys();
      offBridge();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(thumbTimer);
      window.removeEventListener("beforeunload", beforeUnload);
      // disposal runs inside an owned scope: no reactive writes here
      setTimeout(() => {
        void ed.save();
        ui.closeMenus();
        ui.closeDialog();
      });
    };
  });

  const saveJson = () => {
    const blob = new Blob([JSON.stringify(snapshot(ed.state.doc), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${ed.state.doc.name.replace(/[^\w-]+/g, "_") || "project"}.tsl-graph.json`;
    a.click();
  };
  const loadJson = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        let data: ProjectDoc;
        let summary = "Project loaded";
        if (isTslGraphExport(json)) {
          // export from tsl-graph.xyz
          const result = importTslGraph(json, ed.state.doc.name);
          data = result.doc;
          summary = summarizeImport(result.report);
        } else if ((json as ProjectDoc).graphs?.material) {
          data = json as ProjectDoc;
        } else {
          throw new Error("Not a TSL Graph project file");
        }
        const next: ProjectDoc = { ...snapshot(ed.state.doc), graphs: data.graphs, globals: data.globals ?? [], customNodes: data.customNodes ?? [], settings: { ...ed.state.doc.settings, ...data.settings } } as ProjectDoc;
        ed.replaceDoc(next, { history: true });
        ed.mutate(() => {}, { history: false });
        requestAnimationFrame(() => ed.fitView());
        ui.toast(summary, summary.includes("unsupported") || summary.includes("dropped") ? "info" : "success");
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), "error");
      }
    };
    input.click();
  };

  return (
    <EditorContext value={ed}>
      <ChatContext value={chat}>
      {/* like the original: the canvas fills the window and the panels float over it */}
      <div class="absolute inset-0 overflow-hidden">
        <Canvas />
        <div class="pointer-events-none absolute inset-4 flex gap-2">
        <div class="relative h-full shrink-0 *:pointer-events-auto">
          <Sidebar />
        </div>
        <div class="relative min-w-0 flex-1 *:pointer-events-auto">
          <TopBar embed={props.embed} onSaveJson={saveJson} onLoadJson={loadJson} />
          <FindBar />
          <AIChat />
        </div>
        <div class="pointer-events-auto flex w-72 shrink-0 flex-col gap-2">
          <PreviewPanel
            onReady={(p) => {
              ed.previewHooks.setUniform = (key, value) => p.setUniform(key, value);
              ed.previewHooks.capture = (w, h) => p.snapshot(w, h);
              ed.previewHooks.thumbnail = () => p.thumbnail();
            }}
          />
          <Inspector />
        </div>
        </div>
        <div class="pointer-events-none absolute inset-0 *:pointer-events-auto">
          <Toolbar />
        </div>
      </div>
      <NodePicker />
      <ContextMenu />
      <Dialogs persist={props.persist} />
      <Toasts />
      </ChatContext>
    </EditorContext>
  );
}
