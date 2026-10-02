// Fixture page for the canvas end-to-end tests (tests/e2e): the real editor on a small,
// known project. `?static=1` renders a static NodeCard (node reference pages) instead.
import { render } from "@solidjs/web";
import { GraphEditor, NodeCard, type GraphHost } from "../../src/editor";
import { addNode, connect, createLoop, createProject, resolvePorts, setNodePreviewDefault } from "../../src/core/graph";
import type { GraphNode, ProjectDoc } from "../../src/core/types";
import "../styles.css";

const host: GraphHost = {
  projects: {
    load: () => Promise.reject(new Error("e2e: in-memory only")),
    save: async () => {},
    create: () => Promise.reject(new Error("e2e: in-memory only")),
  },
  openProject: () => {},
};

/**
 *   time ──► mul ──► material.colorNode        grp [ inner ]     grp2 [ ]
 *   col  ──► mul.b                              free / cmt        loop [ parts ] (below)
 */
export function fixture(): ProjectDoc {
  const doc = createProject("E2E");
  const g = doc.graphs.material;
  const material = g.nodes.find((n) => n.type.startsWith("material/"))!;
  material.id = "material";
  material.position = { x: 300, y: 0 };
  const add = (id: string, type: string, x: number, y: number, extra: Partial<GraphNode> = {}) => {
    const n = addNode(doc, "material", type, { x, y });
    n.id = id;
    Object.assign(n, extra);
    return n;
  };
  add("time", "geo/time", -300, -60);
  add("col", "const/color", -300, 120);
  add("mul", "math/mul", 0, 0);
  add("grp", "utils/group", -400, 420, { width: 420, height: 260 });
  add("inner", "math/add", -320, 500, { parentId: "grp" });
  add("free", "math/add", 120, 420);
  add("cmt", "utils/comment", 120, 560);
  add("grp2", "utils/group", 420, 380, { width: 380, height: 300 });
  const loop = createLoop(doc, "material", { x: -400, y: 820 });
  const loopId = loop.loop.id;
  loop.loop.id = "loop";
  for (const n of g.nodes) if (n.parentId === loopId) n.parentId = "loop";
  const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) => {
    const r = connect(doc, "material", { source, sourceHandle, target, targetHandle });
    if (!r.ok) throw new Error(`fixture: ${source}.${sourceHandle} → ${target}.${targetHandle}: ${r.error}`);
    (r.edge as { id: string }).id = `${source}-${target}.${targetHandle}`;
  };
  wire("time", "out", "mul", "a");
  wire("col", "out", "mul", "b");
  wire("mul", "out", "material", "colorNode");
  setNodePreviewDefault(doc, false);
  return doc;
}

const root = document.getElementById("root")!;
if (new URLSearchParams(location.search).get("static") === "1") {
  const doc = fixture();
  const node = doc.graphs.material.nodes.find((n) => n.id === "mul")!;
  const ports = resolvePorts(doc, node);
  render(
    () => (
      <div class="tsl-graph-root tsl-dark" id="static-card" style={{ padding: "40px", width: "300px" }}>
        <NodeCard doc={doc} node={node} inputs={ports.inputs} outputs={ports.outputs} static />
      </div>
    ),
    root,
  );
} else {
  render(() => <GraphEditor host={host} doc={fixture()} embed />, root);
}
