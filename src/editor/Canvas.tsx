import { For, Show, createContext, createMemo, createSignal, onSettled, untrack, useContext } from "solid-js";
import { Graph, type Connection, type ContextTarget, type GraphEdge as ViewEdge, type GraphNode as ViewNode, type HandleRef, type NodeProps } from "solid-graph";
import { LOOP_MODES, canConnectTypes, graphOf, hasPreview, loopModeOf, type LoopMode } from "../core/graph";
import { getNodeDef, typeColor } from "../core/registry";
import type { GraphEdge, GraphNode } from "../core/types";
import { EditorContext } from "./store";
import { NodeCard } from "./NodeCard";
import { renderMarkdown } from "./markdown";
import { ui } from "./ui-state";
import { PREVIEW_SIZE } from "../runtime/preview-size";
import { Group as GroupIcon, Pencil, Repeat } from "lucide-static";
import { Icon } from "../ui";

// The canvas is solid-graph's <Graph>: it renders the editor's nodes and edges and reports
// gestures, which are applied to the document through the editor store (undo, recompile, save).

const kindOf = (n: GraphNode) => getNodeDef(n.type)?.kind;
const isContainer = (n: GraphNode) => {
  const k = kindOf(n);
  return k === "group" || k === "loop";
};

/** A document node as solid-graph sees it. Getters read through the store, so updates stay fine-grained. */
type CanvasNode = ViewNode<GraphNode["data"]> & { source: GraphNode };

function canvasNode(n: GraphNode): CanvasNode {
  const container = () => isContainer(n);
  const comment = () => kindOf(n) === "comment";
  return {
    source: n,
    get id() {
      return n.id;
    },
    get type() {
      return container() ? "container" : comment() ? "comment" : "card";
    },
    get position() {
      return n.position;
    },
    get data() {
      return n.data;
    },
    get width() {
      return container() ? (n.width ?? 400) : comment() ? (n.width ?? 240) : undefined;
    },
    get height() {
      return container() ? (n.height ?? 240) : comment() ? (n.height ?? 120) : undefined;
    },
    get parentId() {
      return n.parentId;
    },
    get container() {
      return container();
    },
    get resizable() {
      return container() || comment();
    },
    get minWidth() {
      return container() ? 200 : 140;
    },
    get minHeight() {
      return container() ? 120 : 60;
    },
    // comments float over the other nodes
    get zIndex() {
      return comment() ? 1 : 0;
    },
  };
}

/** Shared per-canvas data for the node components. */
const CanvasContext = createContext<{
  connected: () => { ins: Map<string, Set<string>>; outs: Map<string, Set<string>> };
  errors: () => Map<string, string>;
}>();

export function Canvas() {
  const ed = useContext(EditorContext);
  let el!: HTMLDivElement;

  // one wrapper per document node / edge, kept as long as the node is, so <Graph> doesn't remount them
  const nodeViews = new WeakMap<GraphNode, CanvasNode>();
  const nodes = createMemo(() =>
    ed.graph().nodes.map((n) => {
      let v = nodeViews.get(n);
      if (!v) nodeViews.set(n, (v = canvasNode(n)));
      return v;
    }),
  );
  const edgeViews = new WeakMap<GraphEdge, ViewEdge>();
  const edges = createMemo(() =>
    ed.graph().edges.map((e) => {
      let v = edgeViews.get(e);
      if (!v)
        edgeViews.set(
          e,
          (v = {
            get id() {
              return e.id;
            },
            get source() {
              return e.source;
            },
            get sourceHandle() {
              return e.sourceHandle;
            },
            get target() {
              return e.target;
            },
            get targetHandle() {
              return e.targetHandle;
            },
            get color() {
              return typeColor(ed.types().get(e.source)?.out[e.sourceHandle]);
            },
          }),
        );
      return v;
    }),
  );

  const nodeErrors = createMemo(() => {
    const m = new Map<string, string>();
    for (const d of ed.diagnostics()) if (d.nodeId && d.level === "error") m.set(d.nodeId, d.message);
    return m;
  });
  const connected = createMemo(() => {
    const ins = new Map<string, Set<string>>();
    const outs = new Map<string, Set<string>>();
    for (const e of ed.graph().edges) {
      if (!ins.has(e.target)) ins.set(e.target, new Set());
      ins.get(e.target)!.add(e.targetHandle);
      if (!outs.has(e.source)) outs.set(e.source, new Set());
      outs.get(e.source)!.add(e.sourceHandle);
    }
    return { ins, outs };
  });

  const portType = (ref: HandleRef) => {
    const t = ed.types().get(ref.nodeId);
    return (ref.type === "source" ? t?.out[ref.handleId ?? ""] : t?.in[ref.handleId ?? ""]) ?? "any";
  };
  const isValidConnection = (c: Connection) =>
    canConnectTypes(portType({ nodeId: c.source, handleId: c.sourceHandle, type: "source" }), portType({ nodeId: c.target, handleId: c.targetHandle, type: "target" }));

  /** What may join a container: no groups in groups, no comments, loop parts only in loops. */
  const canContain = (container: ViewNode, node: ViewNode) => {
    const c = (container as CanvasNode).source;
    const n = (node as CanvasNode).source;
    const k = kindOf(n);
    if (k === "group" || k === "loop" || k === "comment") return false;
    if (n.type.startsWith("loop/")) return kindOf(c) === "loop";
    return true;
  };

  const toUiTarget = (t: ContextTarget) =>
    t.kind === "node" ? ({ kind: "node", id: t.id } as const) : t.kind === "edge" ? ({ kind: "edge", id: t.id } as const) : ({ kind: "canvas" } as const);

  onSettled(() => {
    ed.setCanvas(el);
    // any press on the canvas closes open menus (before nodes and handles see it)
    const close = () => ui.closeMenus();
    el.addEventListener("pointerdown", close, { capture: true });
    requestAnimationFrame(() => {
      if (!ed.state.viewports[ed.state.graph]) ed.fitView();
    });
    return () => {
      el.removeEventListener("pointerdown", close, { capture: true });
      ed.setGraphApi(undefined);
    };
  });

  return (
    <CanvasContext value={{ connected, errors: nodeErrors }}>
      <div ref={el} class="absolute inset-0" onPointerMove={(e) => ed.setPointer({ x: e.clientX, y: e.clientY })}>
        <Graph
          class="graph-canvas"
          nodes={nodes()}
          edges={edges()}
          nodeTypes={{ card: CardNode, container: ContainerNode, comment: CommentNode }}
          selection={ed.state.selection}
          onSelectionChange={(s) => ed.select(s.nodes, s.edges)}
          viewport={ed.viewport()}
          onViewportChange={(v) => ed.setViewport(v)}
          fitViewOnInit={false}
          panOnDrag={ed.state.mode === "pan"}
          onInit={(api) => ed.setGraphApi(api)}
          onNodesMove={(moves, phase) => ed.dragNodes(moves, phase)}
          onNodeResize={(r, phase) => {
            if (phase === "start") return ed.pushHistory();
            ed.updateData(
              r.id,
              (n) => {
                n.width = r.width;
                n.height = r.height;
              },
              { history: false, recompile: false },
            );
          }}
          canContain={canContain}
          isValidConnection={isValidConnection}
          connectionColor={(from) => typeColor(portType(from))}
          pickUpEdges
          onEdgeDetach={(id) =>
            ed.mutate((doc) => {
              const g = graphOf(doc, ed.state.graph);
              g.edges = g.edges.filter((x) => x.id !== id);
            })
          }
          onConnect={(c) => {
            const err = ed.connect({ source: c.source, sourceHandle: c.sourceHandle ?? "", target: c.target, targetHandle: c.targetHandle ?? "" });
            if (err) ui.toast(err, "error");
          }}
          onConnectEnd={(info) => {
            if (info.connected || !info.overPane) return;
            const from = info.from;
            ui.openPicker(info.client, {
              from: { nodeId: from.nodeId, side: from.type === "source" ? "out" : "in", key: from.handleId ?? "", type: portType(from) },
            });
          }}
          contextMenu={false}
          onContextMenu={(target, e) => ui.openContext({ x: e.clientX, y: e.clientY }, toUiTarget(target))}
          onDoubleClick={(target, e) => {
            if (target.kind === "pane") return ui.openPicker({ x: e.clientX, y: e.clientY });
            if (target.kind !== "node") return;
            const n = ed.nodesById().get(target.id);
            const def = n && getNodeDef(n.type);
            if (def?.kind === "subgraph" && n!.data.subgraphId) ed.enterSubgraph(n!.data.subgraphId);
            else if (def?.kind === "code") ui.editCode(target.id);
          }}
          onDragOver={(e) => {
            if (e.dataTransfer?.types.includes("application/x-tsl-node")) e.preventDefault();
          }}
          onDrop={(e) => {
            const type = e.dataTransfer?.getData("application/x-tsl-node");
            const sg = e.dataTransfer?.getData("application/x-tsl-subgraph");
            if (sg) {
              e.preventDefault();
              ui.insertSubgraphById(sg, ed.screenToFlow(e.clientX, e.clientY));
            } else if (type) {
              e.preventDefault();
              ed.addNodeAt(type, ed.screenToFlow(e.clientX, e.clientY));
            }
          }}
        />
      </div>
    </CanvasContext>
  );
}

// ---------------------------------------------------------------------------
// node types
// ---------------------------------------------------------------------------

/** Sets compare by content, so an edit elsewhere in the graph doesn't re-render this node's ports. */
const sameKeys = (a: Set<string> | undefined, b: Set<string> | undefined) =>
  a === b || (!!a && !!b && a.size === b.size && [...a].every((k) => b.has(k)));

/** A regular node: the card with its ports, preview and value readout. */
function CardNode(props: NodeProps<GraphNode["data"]>) {
  const ed = useContext(EditorContext);
  const canvas = useContext(CanvasContext)!;
  const node = () => (props.node as CanvasNode).source;
  const id = untrack(() => node().id);
  // resolved again on every edit (types may change), but only a real change re-renders the ports
  const ports = createMemo(() => ed.resolvePorts(node()), { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const t = createMemo(() => ed.types().get(id));
  const connectedIn = createMemo(() => canvas.connected().ins.get(id), { equals: sameKeys });
  const connectedOut = createMemo(() => canvas.connected().outs.get(id), { equals: sameKeys });
  const error = createMemo(() => canvas.errors().get(id));
  // thumbnails are rendered from the compiled main graph only (material, or function)
  // nodes inside a loop compile into the loop body, so they have no standalone value to show
  const inLoop = () => {
    const parentId = node().parentId;
    const parent = parentId ? ed.nodesById().get(parentId) : undefined;
    return !!parent && getNodeDef(parent.type)?.kind === "loop";
  };
  const previewable = () => (ed.state.graph === "material" || ed.state.graph === "function") && hasPreview(node().type) && !inLoop();
  // math nodes whose output can't vary across the surface show just their value, no picture
  const surfaceUniform = createMemo(() => getNodeDef(node().type)?.category === "Math" && !!ed.surfaceUniform().get(id));

  return (
    <NodeCard
      doc={ed.state.doc}
      node={node()}
      inputs={ports().inputs}
      outputs={ports().outputs}
      selected={props.selected}
      error={error()}
      inTypes={t()?.in}
      outTypes={t()?.out}
      connectedIn={connectedIn()}
      connectedOut={connectedOut()}
      interactive
      previewable={previewable()}
      surfaceUniform={surfaceUniform()}
      valueStats={ui.debugStats()[id]}
      sampleValue={(u, v) => {
        const px = ui.debugPixels.get(id);
        if (!px) return undefined;
        const x = Math.min(PREVIEW_SIZE - 1, Math.max(0, Math.floor(u * PREVIEW_SIZE)));
        const y = Math.min(PREVIEW_SIZE - 1, Math.max(0, Math.floor(v * PREVIEW_SIZE)));
        const i = (y * PREVIEW_SIZE + x) * 4;
        return [px[i], px[i + 1], px[i + 2], px[i + 3]];
      }}
      onToggleDebug={() => ed.toggleNodePreview(id)}
      onMultiOp={(fn) => ed.editMultiOp(id, fn)}
      debugRef={(c) => ui.registerDebugCanvas(id, c)}
    />
  );
}

/**
 * Groups and loops (the original draws both the same way): name above the box,
 * and a 1rem frame inside the border is the drag handle. The inside is canvas
 * (box select, pan); solid-graph sizes the node and draws the resize grip.
 */
function ContainerNode(props: NodeProps<GraphNode["data"]>) {
  const ed = useContext(EditorContext);
  const node = () => (props.node as CanvasNode).source;
  const isLoop = () => kindOf(node()) === "loop";
  const kindName = () => (isLoop() ? "Loop" : "Group");
  const [editing, setEditing] = createSignal(false);
  // The drag frame is one element clipped to a ring, so the whole ring hovers together and only the
  // ring takes the pointer (clip-path also clips hit testing). Sizes are inside the 2px border.
  const ringPath = createMemo(() => {
    const w = (node().width ?? 400) - 4;
    const h = (node().height ?? 240) - 4;
    const t = 16; // 1rem
    const r = 12; // outer: the box's inner corner radius (rounded-xl minus the border)
    const ri = 6; // inner: tighter, so the bar reads as an even thickness around the corners
    const rr = (x: number, y: number, rw: number, rh: number, rad: number) => {
      const k = Math.max(0, Math.min(rad, rw / 2, rh / 2));
      return `M${x + k} ${y}H${x + rw - k}A${k} ${k} 0 0 1 ${x + rw} ${y + k}V${y + rh - k}A${k} ${k} 0 0 1 ${x + rw - k} ${y + rh}H${x + k}A${k} ${k} 0 0 1 ${x} ${y + rh - k}V${y + k}A${k} ${k} 0 0 1 ${x + k} ${y}Z`;
    };
    return `path(evenodd, "${rr(0, 0, w, h, r)} ${rr(t, t, w - 2 * t, h - 2 * t, ri)}")`;
  });
  return (
    <div
      class={[
        "relative h-full w-full rounded-xl border-2 border-dashed bg-neutral-500/10 transition-colors dark:bg-neutral-400/[0.12]",
        // selected: the same neutral border, a step more contrast
        props.selected ? "border-neutral-500 dark:border-white/45" : "border-neutral-400/60 dark:border-white/20",
      ]}
    >
      <div
        data-drag-handle
        class="absolute inset-0 cursor-grab bg-neutral-500/10 transition-colors hover:bg-neutral-500/20 active:cursor-grabbing dark:bg-white/[0.05] dark:hover:bg-white/[0.09]"
        style={{ "clip-path": ringPath() }}
      />

      {/* name, outside the box */}
      <div class="absolute bottom-full left-0 mb-2 flex max-w-full items-center gap-3">
        <div
          data-drag-handle
          title={`Drag to move the ${kindName().toLowerCase()}`}
          class="flex size-8 shrink-0 cursor-grab items-center justify-center rounded-lg bg-neutral-500/15 text-gray-500 active:cursor-grabbing dark:bg-white/[0.07] dark:text-white/60"
        >
          <Icon svg={isLoop() ? Repeat : GroupIcon} class="size-4" />
        </div>
        <Show
          when={editing()}
          fallback={
            <div
              data-nodrag
              class="group/name flex min-w-0 cursor-text items-center gap-2"
              title={`Rename ${kindName().toLowerCase()}`}
              onClick={() => setEditing(true)}
            >
              <span class={["truncate text-lg font-medium", node().data.label ? "text-gray-700 dark:text-white/80" : "text-gray-400 dark:text-white/35"]}>
                {node().data.label ?? kindName()}
              </span>
              <Icon svg={Pencil} class="size-4 shrink-0 text-gray-500 opacity-0 transition-opacity group-hover/name:opacity-100 dark:text-white/60" />
            </div>
          }
        >
          {/* pulled left by its padding + border so the text doesn't move when editing starts */}
          <input
            data-nodrag
            class="-ml-[7.5px] w-56 rounded-md border-[1.5px] border-ring/60 bg-background px-1.5 py-0 text-lg font-medium outline-none"
            value={node().data.label ?? ""}
            placeholder={`${kindName()} name...`}
            ref={(i) => requestAnimationFrame(() => i.select())}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              setEditing(false);
              if (v !== (node().data.label ?? "")) ed.updateData(node().id, (n) => (n.data.label = v || undefined), { recompile: false });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
              e.stopPropagation();
            }}
          />
        </Show>
        <Show when={isLoop()}>
          {/* loop mode, next to the name like the original */}
          <select
            data-nodrag
            aria-label="Loop mode"
            class="h-8 shrink-0 cursor-pointer rounded-md border border-input bg-background px-2 text-sm text-gray-700 outline-none dark:text-white/80"
            value={loopModeOf(node(), ed.graph().nodes.filter((n) => n.parentId === node().id))}
            onChange={(e) => ed.setLoopMode(node().id, e.currentTarget.value as LoopMode)}
          >
            <For each={LOOP_MODES}>{(m) => <option value={m.value}>{m.label}</option>}</For>
          </select>
        </Show>
      </div>
    </div>
  );
}

/** A markdown note; double-click to edit. */
function CommentNode(props: NodeProps<GraphNode["data"]>) {
  const ed = useContext(EditorContext);
  const node = () => (props.node as CanvasNode).source;
  const [editing, setEditing] = createSignal(false);
  const html = createMemo(() => renderMarkdown(node().data.text ?? ""));
  const highlighted = () => ui.findHighlight() === node().id;
  return (
    <div
      class={[
        "flex h-full w-full flex-col overflow-hidden rounded-lg border bg-amber-100/90 text-gray-800 shadow-md dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-50/90",
        { "ring-2 ring-blue-500": props.selected, "ring-2 ring-amber-400": highlighted() && !props.selected },
      ]}
      onDblClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      <Show
        when={editing()}
        fallback={
          <div class="md thin-scroll h-full overflow-auto px-3 py-2 text-xs">
            <Show when={node().data.text} fallback={<span class="opacity-50">Add markdown notes...</span>}>
              <div innerHTML={html()} />
            </Show>
          </div>
        }
      >
        <textarea
          data-nodrag
          class="h-full w-full resize-none bg-transparent px-3 py-2 font-mono text-xs outline-none"
          placeholder="Write markdown notes..."
          value={node().data.text ?? ""}
          ref={(t) => requestAnimationFrame(() => t.focus())}
          onBlur={(e) => {
            const v = e.currentTarget.value;
            setEditing(false);
            if (v !== (node().data.text ?? "")) ed.updateData(node().id, (n) => (n.data.text = v), { recompile: false });
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
            e.stopPropagation();
          }}
        />
      </Show>
    </div>
  );
}
