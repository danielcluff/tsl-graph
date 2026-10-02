// Synthetic projects for the canvas benchmark: a mix of node types modelled on a real
// project (constants, noise, math chains, groups, comments), tiled to any size.
import { addNode, checkConnection, connect, createProject, resolvePorts, setNodePreviewDefault } from "../../src/core/graph";
import { getNodeDef } from "../../src/core/registry";
import type { GraphNode, ProjectDoc } from "../../src/core/types";

/** One cell: a short chain the way shaders are usually built. */
const CELL = [
  "const/color",
  "geo/positionWorld",
  "geo/time",
  "math/mul",
  "noise/fractal_noise_float",
  "math/add",
  "math/mix",
  "math/remap",
];
const CELL_W = CELL.length * 260;
const CELL_H = 340;
const COLS = 3;

/** Deterministic: the same `nodes` always gives the same graph (ids aside). */
export function benchProject(nodes: number, opts: { previews?: boolean } = {}): ProjectDoc {
  const doc = createProject(`Bench ${nodes}`);
  const g = doc.graphs.material;
  const material = g.nodes.find((n) => n.type.startsWith("material/"))!;
  const types = CELL.filter((t) => getNodeDef(t));
  let prevLast: GraphNode | undefined;
  let count = g.nodes.length;
  for (let cell = 0; count < nodes; cell++) {
    const ox = (cell % COLS) * (CELL_W + 200);
    const oy = Math.floor(cell / COLS) * (CELL_H + 160) + 400;
    if (cell % 6 === 5) {
      const grp = addNode(doc, "material", "utils/group", { x: ox - 40, y: oy - 40 });
      grp.width = CELL_W + 40;
      grp.height = CELL_H;
      count++;
    }
    if (cell % 10 === 9) {
      addNode(doc, "material", "utils/comment", { x: ox, y: oy - 150 }, { text: `## Cell ${cell}\nSome **notes** about this part.` });
      count++;
    }
    const made: GraphNode[] = [];
    for (let i = 0; i < types.length && count < nodes; i++) {
      const n = addNode(doc, "material", types[i], { x: ox + i * 260, y: oy + (i % 2) * 60 });
      if (cell % 6 === 5) n.parentId = g.nodes.find((x) => x.type === "utils/group" && x.position.x === ox - 40 && x.position.y === oy - 40)?.id;
      made.push(n);
      count++;
    }
    // wire each node to up to two earlier ones in its cell, plus one edge from the previous cell
    for (let j = 1; j < made.length; j++) {
      let wired = 0;
      for (let k = j - 1; k >= 0 && wired < 2; k--) wired += tryConnect(doc, made[k], made[j]) ? 1 : 0;
    }
    if (prevLast && made.length > 3) tryConnect(doc, prevLast, made[3]);
    prevLast = made.at(-1);
  }
  if (prevLast) tryConnect(doc, prevLast, material);
  setNodePreviewDefault(doc, opts.previews ?? false);
  return doc;
}

function tryConnect(doc: ProjectDoc, from: GraphNode, to: GraphNode): boolean {
  const taken = new Set(doc.graphs.material.edges.filter((e) => e.target === to.id).map((e) => e.targetHandle));
  const outs = resolvePorts(doc, from).outputs;
  for (const inp of resolvePorts(doc, to, { forCanvas: true }).inputs) {
    if (taken.has(inp.key)) continue;
    for (const out of [...outs].reverse()) {
      const c = { source: from.id, sourceHandle: out.key, target: to.id, targetHandle: inp.key };
      if (checkConnection(doc, "material", c).ok) return connect(doc, "material", c).ok;
    }
  }
  return false;
}
