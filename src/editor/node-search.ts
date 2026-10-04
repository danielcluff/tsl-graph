import { canConnectTypes, makeNode, resolvePorts } from "../core/graph";
import { allNodeDefs } from "../core/registry";
import type { GraphKind, NodeDef, PortDef, ProjectDoc } from "../core/types";
import type { Editor } from "./store";

// Node search shared by the quick-add picker and the canvas context menu.

export interface PendingWire {
  side: "in" | "out";
  type: string;
}

/** The port on a new `def` node that a dragged wire would attach to. */
export function compatiblePort(def: NodeDef, from: PendingWire, doc: ProjectDoc): PortDef | undefined {
  const ports = resolvePorts(doc, makeNode(def.type, { x: 0, y: 0 }));
  const list = from.side === "out" ? ports.inputs.filter((p) => !p.propertyOnly) : ports.outputs;
  const ok = list.filter((p) => (from.side === "out" ? canConnectTypes(from.type, p.type) : canConnectTypes(p.type, from.type)));
  return ok.find((p) => p.type === from.type) ?? ok.find((p) => p.key === "out") ?? ok[0];
}

/** Node types that can be added to the active graph (optionally: that accept a dragged wire). */
export function addableNodeDefs(ed: Editor, from?: PendingWire): NodeDef[] {
  const graph = ed.state.graph;
  const kind: GraphKind = ed.topGraph();
  let defs = allNodeDefs().filter(
    (d) =>
      d.category !== "Subgraph" &&
      d.kind !== "placeholder" &&
      d.category !== "Loop" &&
      d.type !== "utils/group" &&
      (!d.graphs || graph.startsWith("sg:") || d.graphs.includes(kind)),
  );
  if (from) defs = defs.filter((d) => compatiblePort(d, from, ed.state.doc));
  return defs;
}

/** Match quality of a node for a query (lower is better), or null when it doesn't match. */
export function matchScore(d: NodeDef, query: string, opts: { description?: boolean } = {}): number | null {
  const label = d.label.toLowerCase();
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.split(/[\s_-]+/).some((w) => w.startsWith(query))) return 2;
  if (label.includes(query)) return 3;
  // the id's name part only: the category prefix ("easing/…") would match unrelated queries
  const id = d.type.slice(d.type.indexOf("/") + 1).toLowerCase();
  if (id.includes(query) || (d.tsl ?? "").toLowerCase().includes(query)) return 4;
  if (opts.description && (d.description ?? "").toLowerCase().includes(query)) return 5;
  return null;
}

/** Group order of the original editor's command list. */
const COMMAND_ORDER = [
  "Constants",
  "Math",
  "Easing",
  "Geometry",
  "Material",
  "Texture",
  "Model",
  "Advanced",
  "Noise",
  "Notes",
  "Utils",
  "SDF",
  "Logic",
  "Globals",
  "Locals",
  "Post",
  "Post FX",
  "TSL Textures",
];
const groupRank = (c: string) => (COMMAND_ORDER.includes(c) ? COMMAND_ORDER.indexOf(c) : COMMAND_ORDER.length);

export interface NodeGroup {
  category: string;
  nodes: NodeDef[];
}

/**
 * Matching nodes (all of them for an empty query) grouped by category, like the original's command list:
 * groups in its fixed order, best matches first within each group.
 */
export function groupedMatches(defs: NodeDef[], query: string): NodeGroup[] {
  const q = query.toLowerCase().trim();
  const groups = new Map<string, { def: NodeDef; score: number }[]>();
  for (const def of defs) {
    const score = q ? matchScore(def, q) : 0;
    if (score === null) continue;
    let g = groups.get(def.category);
    if (!g) groups.set(def.category, (g = []));
    g.push({ def, score });
  }
  return [...groups]
    .sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
    .map(([category, list]) => ({
      category,
      // like the original: shorter labels first among equal matches, then registry order (stable sort);
      // the unfiltered list is plain registry order
      nodes: (q ? list.sort((a, b) => a.score - b.score || a.def.label.length - b.def.label.length) : list).map((x) => x.def),
    }));
}
