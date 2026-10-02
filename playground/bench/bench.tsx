// Canvas benchmark: mounts the real editor on a generated project and drives the canvas with
// real DOM events (wheel, pointer), timing each step until the update has been applied and laid out.
// It only relies on markup both the built-in canvas and solid-graph produce, so the same run can
// be compared across the two.
//
//   /bench.html?n=200&previews=0&steps=60&reps=2&scenarios=pan,zoom
//
// Results: shown on the page, logged, and kept in `window.__bench`.
import { render } from "@solidjs/web";
import { GraphEditor, type GraphHost } from "../../src/editor";
import { benchProject } from "./generate";
import "../styles.css";

const params = new URLSearchParams(location.search);
const N = Number(params.get("n") ?? 200);
const PREVIEWS = params.get("previews") === "1";
const STEPS = Number(params.get("steps") ?? 60);
const REPS = Number(params.get("reps") ?? 2);
const ONLY = params.get("scenarios")?.split(",");

const host: GraphHost = {
  projects: {
    load: () => Promise.reject(new Error("bench: in-memory only")),
    save: async () => {},
    create: () => Promise.reject(new Error("bench: in-memory only")),
  },
  openProject: () => {},
};

// ---- timing ------------------------------------------------------------------

/** Next task: after every microtask (Solid flushes in one) has run. */
const nextTask = () =>
  new Promise<void>((r) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => r();
    c.port2.postMessage(0);
  });
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

const canvas = () => document.querySelector<HTMLElement>(".graph-canvas, .solid-graph")!;

/**
 * Runs `fn` at the start of a frame; time until its update has been flushed (Solid flushes in a
 * microtask) and the page restyled and laid out. Painting isn't included: when it happens relative
 * to a task is up to the browser, which made the numbers jump by a frame.
 */
async function step(fn: () => void): Promise<number> {
  await frame();
  const t0 = performance.now();
  fn();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  void document.body.offsetHeight; // force style + layout
  for (const el of document.querySelectorAll<HTMLElement>("[data-node-id]")) {
    void el.offsetWidth;
    break;
  }
  return performance.now() - t0;
}

interface Stats {
  steps: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
  /** Long animation frames (>50ms) seen while the scenario ran. */
  longFrames: number;
}

function stats(xs: number[], longFrames: number): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = (v: number) => Math.round(v * 100) / 100;
  return { steps: s.length, median: r(q(0.5)), p95: r(q(0.95)), max: r(s.at(-1) ?? 0), mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)), longFrames };
}

let longFrames = 0;
try {
  new PerformanceObserver((l) => (longFrames += l.getEntries().length)).observe({ type: "long-animation-frame", buffered: false });
} catch {
  // not supported: longFrames stays 0
}

// ---- input -------------------------------------------------------------------

const pointer = (type: string, x: number, y: number, extra: PointerEventInit = {}) => {
  const target = document.elementFromPoint(x, y) ?? document.body;
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      ...extra,
    }),
  );
};
const wheel = (x: number, y: number, init: WheelEventInit) =>
  (document.elementFromPoint(x, y) ?? canvas()).dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaMode: 0, ...init }),
  );
const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true }));

const NO_DRAG = "[data-handle],[data-nodrag],input,textarea,select,button,a,canvas,[contenteditable='true']";

/** A point on the node's header that starts a drag (not a handle, input, or nested node). */
function grabPoint(id: string): { x: number; y: number } | null {
  const el = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  for (let fy = 0.02; fy < 0.3; fy += 0.02)
    for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      if (hit && hit.closest("[data-node-id]") === el && !hit.closest(NO_DRAG)) return { x, y };
    }
  return null;
}

/** A point over empty canvas inside the visible area. */
function emptyPoint(fromX = 0.02, fromY = 0.1): { x: number; y: number } {
  const r = canvas().getBoundingClientRect();
  for (let fy = fromY; fy < 0.95; fy += 0.03)
    for (let fx = fromX; fx < 0.95; fx += 0.03) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      if (hit && canvas().contains(hit) && !hit.closest("[data-node-id],[data-edge-id],[data-ui],[data-sg-overlay]")) return { x, y };
    }
  throw new Error("no empty canvas point");
}

function outHandle(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-node-id="${CSS.escape(id)}"] [data-handle^="out:"], [data-node-id="${CSS.escape(id)}"] [data-handle-type="source"]`,
  );
}

// ---- editor access ---------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ed = any;
const tsl = () => (window as unknown as { __tsl: { ed: Ed; ui: { closeMenus(): void } } }).__tsl;
const ed = () => tsl().ed;

/** Viewport at zoom 1 with node `id` in the middle of the canvas. */
function centerOn(id: string, zoom = 1) {
  const n = ed().nodesById().get(id);
  const r = canvas().getBoundingClientRect();
  ed().setViewport({ zoom, x: r.width / 2 - (n.position.x + 90) * zoom, y: r.height / 2 - (n.position.y + 60) * zoom });
}

/** A well-connected regular node near the middle of the graph. */
function pickNode(type = "math/mix"): string {
  const nodes = ed().graph().nodes.filter((n: { type: string }) => n.type === type);
  return nodes[Math.floor(nodes.length / 2)].id;
}

const posOf = (id: string) => ({ ...ed().nodesById().get(id).position });
function check(ok: unknown, what: string) {
  if (!ok) throw new Error(`check failed: ${what}`);
}

/** Lets pending work finish (e.g. the recompile an undo schedules) so it isn't timed in the next step. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 300));
  await frame();
  await frame();
  await nextTask();
};

// ---- scenarios ------------------------------------------------------------------

type Scenario = (record: (fn: () => void) => Promise<void>) => Promise<void>;

const scenarios: Record<string, Scenario> = {
  /** Nothing: the fixed cost of a measured step (a frame and a layout pass). */
  async idle(record) {
    ed().fitView();
    await settle();
    for (let i = 0; i < STEPS; i++) await record(() => {});
  },
  /** Trackpad pan with the whole graph in view. */
  async pan(record) {
    ed().fitView();
    await settle();
    const r = canvas().getBoundingClientRect();
    for (let i = 0; i < STEPS; i++) await record(() => wheel(r.left + r.width / 2, r.top + r.height / 2, { deltaX: i % 20 < 10 ? 8 : -8, deltaY: 2 }));
  },
  /** Pinch zoom in and out around the centre, whole graph in view. */
  async zoom(record) {
    ed().fitView();
    await settle();
    const r = canvas().getBoundingClientRect();
    for (let i = 0; i < STEPS; i++)
      await record(() => wheel(r.left + r.width / 2, r.top + r.height / 2, { deltaY: i < STEPS / 2 ? -6 : 6, ctrlKey: true }));
  },
  /** Drag one node with its edges at zoom 1. */
  async dragNode(record) {
    const id = pickNode();
    centerOn(id);
    ed().clearSelection();
    await settle();
    const p = grabPoint(id);
    if (!p) throw new Error("dragNode: no grab point");
    const start = posOf(id);
    await record(() => pointer("pointerdown", p.x, p.y));
    for (let i = 1; i <= STEPS; i++) await record(() => pointer("pointermove", p.x + i * 3, p.y + Math.sin(i / 5) * 20));
    await record(() => pointer("pointerup", p.x + STEPS * 3, p.y));
    await settle();
    check(Math.abs(posOf(id).x - start.x - STEPS * 3) < 2, "dragNode moved the node");
    ed().undo();
  },
  /** Drag every node at once (select all), whole graph in view. */
  async dragAll(record) {
    ed().fitView();
    ed().select(ed().graph().nodes.map((n: { id: string }) => n.id));
    await settle();
    const first = ed().graph().nodes[0].id;
    const start = posOf(first);
    const p = grabPoint(pickNode());
    if (!p) throw new Error("dragAll: no grab point");
    await record(() => pointer("pointerdown", p.x, p.y));
    for (let i = 1; i <= STEPS; i++) await record(() => pointer("pointermove", p.x + i * 2, p.y + i));
    await record(() => pointer("pointerup", p.x + STEPS * 2, p.y + STEPS));
    await settle();
    check(posOf(first).x > start.x, "dragAll moved every node");
    ed().undo();
    ed().clearSelection();
  },
  /** Box-select sweeping across the whole graph. */
  async boxSelect(record) {
    ed().fitView();
    ed().clearSelection();
    await settle();
    const a = emptyPoint();
    const r = canvas().getBoundingClientRect();
    await record(() => pointer("pointerdown", a.x, a.y));
    for (let i = 1; i <= STEPS; i++)
      await record(() => pointer("pointermove", a.x + ((r.right - 10 - a.x) * i) / STEPS, a.y + ((r.bottom - 10 - a.y) * i) / STEPS));
    await record(() => pointer("pointerup", r.right - 10, r.bottom - 10));
    await settle();
    check(ed().state.selection.nodes.length > 5, "boxSelect selected nodes");
    ed().clearSelection();
  },
  /** Drag a wire from an output across nearby nodes (hit testing + snapping), drop on empty canvas. */
  async connect(record) {
    const id = pickNode("math/mul");
    centerOn(id, 0.8);
    await settle();
    const h = outHandle(id);
    if (!h) throw new Error("connect: no output handle");
    const hr = h.getBoundingClientRect();
    const p = { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 };
    await record(() => pointer("pointerdown", p.x, p.y));
    for (let i = 1; i <= STEPS; i++) await record(() => pointer("pointermove", p.x + i * 6, p.y + Math.sin(i / 4) * 80));
    check(document.querySelector("path[stroke-dasharray], .solid-graph svg > path"), "connect drew a wire");
    const end = emptyPoint(0.5, 0.05);
    const edges = ed().graph().edges.length;
    await record(() => pointer("pointerup", end.x, end.y));
    await settle();
    check(ed().graph().edges.length === edges, "connect dropped on empty canvas");
    key("Escape");
    tsl().ui.closeMenus();
    await settle();
  },
  /** Click to select different nodes, one after another (zoom 0.6). */
  async select(record) {
    const ids: string[] = ed()
      .graph()
      .nodes.filter((n: { type: string }) => n.type.startsWith("math/"))
      .map((n: { id: string }) => n.id);
    const mid = ids[Math.floor(ids.length / 2)];
    centerOn(mid, 0.6);
    await settle();
    const visible = ids.map((id) => [id, grabPoint(id)] as const).filter((x): x is [string, { x: number; y: number }] => !!x[1]);
    if (!visible.length) throw new Error("select: no visible nodes");
    for (let i = 0; i < STEPS; i++) {
      const [id, p] = visible[i % visible.length];
      await record(() => {
        pointer("pointerdown", p.x, p.y);
        pointer("pointerup", p.x, p.y);
      });
      check(ed().state.selection.nodes.join() === id, "select selected the clicked node");
    }
    ed().clearSelection();
  },
  /** Add a node and undo it, in the full graph. */
  async addRemove(record) {
    ed().fitView();
    await settle();
    for (let i = 0; i < Math.min(STEPS, 30); i++) {
      const count = ed().graph().nodes.length;
      await record(() => ed().addNodeAt("math/add", { x: 100 + i * 10, y: 100 }));
      check(document.querySelectorAll("[data-node-id]").length === count + 1, "addRemove rendered the node");
      await record(() => ed().undo());
    }
  },
};

// ---- run ----------------------------------------------------------------------------

const status = document.getElementById("status")!;
const out = document.getElementById("results")!;

async function main() {
  const doc = benchProject(N, { previews: PREVIEWS });
  const total = doc.graphs.material.nodes.length;
  status.textContent = `mounting ${total} nodes…`;
  const t0 = performance.now();
  render(() => <GraphEditor host={host} doc={doc} embed />, document.getElementById("root")!);
  while (document.querySelectorAll("[data-node-id]").length < total || !canvas()) await frame();
  await frame();
  await frame();
  const mountMs = Math.round(performance.now() - t0);
  await new Promise((r) => setTimeout(r, 500)); // let the first compile and previews start

  const impl = canvas().classList.contains("solid-graph") ? "solid-graph" : "builtin";
  const results: Record<string, Stats[]> = {};
  for (let rep = 0; rep < REPS; rep++) {
    for (const [name, run] of Object.entries(scenarios)) {
      if (ONLY && !ONLY.includes(name)) continue;
      status.textContent = `rep ${rep + 1}/${REPS}: ${name}`;
      const times: number[] = [];
      longFrames = 0;
      try {
        await run(async (fn) => void times.push(await step(fn)));
        (results[name] ??= []).push(stats(times, longFrames));
      } catch (err) {
        console.error(name, err);
        (results[name] ??= []).push({ steps: 0, median: NaN, p95: NaN, max: NaN, mean: NaN, longFrames: 0 });
      }
      await settle();
    }
  }

  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  const report = {
    impl,
    nodes: total,
    edges: doc.graphs.material.edges.length,
    previews: PREVIEWS,
    steps: STEPS,
    canvas: { width: canvas().clientWidth, height: canvas().clientHeight, dpr: devicePixelRatio },
    mountMs,
    heapMB: heap ? Math.round(heap / 1e5) / 10 : undefined,
    domNodes: document.getElementsByTagName("*").length,
    // the last rep (warm); every rep is kept in `reps`
    results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.at(-1)])),
    reps: results,
    at: new Date().toISOString(),
  };
  (window as unknown as { __bench: unknown }).__bench = report;
  console.log("bench", report);
  console.table(report.results);
  status.textContent = "done";
  out.hidden = false;
  out.textContent = JSON.stringify(report, null, 2);
}

void main();
