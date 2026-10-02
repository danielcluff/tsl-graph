// Page helpers for the canvas tests. They only rely on markup both the built-in canvas and
// solid-graph render ([data-node-id], [data-edge-id], handles) and on the editor store
// (window.__tsl in dev), so the same tests run against either implementation.
import { chromium, type Browser, type Page } from "playwright-core";
import { inject } from "vitest";

export interface XY {
  x: number;
  y: number;
}

export interface Snapshot {
  nodes: Record<string, { x: number; y: number; width?: number; height?: number; parentId?: string }>;
  edges: { id: string; source: string; sourceHandle: string; target: string; targetHandle: string }[];
  selection: { nodes: string[]; edges: string[] };
  viewport: { x: number; y: number; zoom: number };
  picker: { from?: { nodeId: string; side: string; key: string } } | null;
  context: { kind: string; id?: string } | null;
  history: number;
}

let browser: Browser | undefined;

export async function launch(): Promise<Browser> {
  browser ??= await chromium.launch({ headless: !process.env.HEADED });
  return browser;
}

export async function closeBrowser() {
  await browser?.close();
  browser = undefined;
}

/** A fresh editor on the fixture project, viewport at a known spot (zoom 1). */
export async function openEditor(): Promise<Page & { errors: string[] }> {
  const page = (await (await launch()).newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${inject("baseUrl")}/e2e.html`);
  await page.waitForFunction(() => (window as any).__tsl && document.querySelector('[data-node-id="mul"]'));
  await setViewport(page, { x: 720, y: 220, zoom: 1 });
  return page;
}

/** Waits two frames, so measurements and effects have run. */
export const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r)))));

export async function setViewport(page: Page, v: { x: number; y: number; zoom: number }) {
  await page.evaluate((v) => (window as any).__tsl.ed.setViewport(v), v);
  await settle(page);
}

export function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const { ed, ui } = (window as any).__tsl;
    const g = ed.graph();
    const picker = ui.picker();
    return {
      nodes: Object.fromEntries(
        g.nodes.map((n: any) => [n.id, { x: n.position.x, y: n.position.y, width: n.width, height: n.height, parentId: n.parentId }]),
      ),
      edges: g.edges.map((e: any) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle })),
      selection: { nodes: [...ed.state.selection.nodes], edges: [...ed.state.selection.edges] },
      viewport: { ...ed.viewport() },
      picker: picker ? { from: picker.pending?.from && { ...picker.pending.from } } : null,
      context: ui.context() ? { ...ui.context().target } : null,
      history: ed.historyMark(),
    };
  });
}

/** Client rect of the canvas. */
export const canvasRect = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector(".graph-canvas, .solid-graph")!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

export const nodeRect = (page: Page, id: string) =>
  page.evaluate((id) => {
    const r = document.querySelector(`[data-node-id="${id}"]`)!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, id);

/** A point on a node's header that starts a drag (not a handle, control or nested node). */
export function grabPoint(page: Page, id: string): Promise<XY> {
  return page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
    const r = el.getBoundingClientRect();
    const noDrag = "[data-handle],[data-nodrag],input,textarea,select,button,a,canvas,[contenteditable='true']";
    for (let y = r.top + 3; y < r.top + Math.min(r.height, 40); y += 3)
      for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const x = r.left + r.width * fx;
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        if (hit && hit.closest("[data-node-id]") === el && !hit.closest(noDrag)) return { x, y };
      }
    throw new Error(`no grab point on ${id}`);
  }, id);
}

/** A point on a group's drag frame (the ring inside its border), left side, halfway down. */
export const groupGrip = async (page: Page, id: string): Promise<XY> => {
  const r = await nodeRect(page, id);
  return { x: r.x + 9, y: r.y + r.height / 2 };
};

/** Centre of a handle: `side` "in"/"out", `key` the port. */
export function handlePoint(page: Page, id: string, side: "in" | "out", key: string): Promise<XY & { width: number }> {
  return page.evaluate(
    ({ id, side, key }) => {
      const type = side === "in" ? "target" : "source";
      const h =
        document.querySelector(`[data-node-id="${id}"] [data-handle="${side}:${key}"]`) ??
        document.querySelector(`[data-handle-node="${id}"][data-handle-type="${type}"][data-handle-id="${key}"]`);
      if (!h) throw new Error(`no handle ${id} ${side}:${key}`);
      const r = h.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width };
    },
    { id, side, key },
  );
}

/** Screen end points (and midpoint) of an edge's path. */
export function edgePoints(page: Page, id: string): Promise<{ start: XY; end: XY; mid: XY }> {
  return page.evaluate((id) => {
    const p = document.querySelector<SVGPathElement>(`path[data-edge-id="${id}"]`);
    if (!p) throw new Error(`no edge ${id}`);
    const m = p.getScreenCTM()!;
    const at = (l: number) => {
      const q = p.getPointAtLength(l);
      return { x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f };
    };
    const len = p.getTotalLength();
    return { start: at(0), end: at(len), mid: at(len / 2) };
  }, id);
}

/** An empty spot of canvas near `near` (searching outwards), not over nodes, edges or chrome. */
export function emptyPoint(page: Page, near: XY): Promise<XY> {
  return page.evaluate((near) => {
    const canvas = document.querySelector(".graph-canvas, .solid-graph")!;
    for (let r = 0; r < 400; r += 10)
      for (let a = 0; a < 16; a++) {
        const x = near.x + Math.cos((a / 16) * Math.PI * 2) * r;
        const y = near.y + Math.sin((a / 16) * Math.PI * 2) * r;
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        if (hit && canvas.contains(hit) && !hit.closest("[data-node-id],[data-edge-id],[data-ui],[data-sg-overlay]")) return { x, y };
      }
    throw new Error("no empty canvas point");
  }, near);
}

export async function drag(page: Page, from: XY, to: XY, opts: { steps?: number; button?: "left" | "middle"; shift?: boolean } = {}) {
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: opts.button ?? "left" });
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 8 });
  await page.mouse.up({ button: opts.button ?? "left" });
  if (opts.shift) await page.keyboard.up("Shift");
  await settle(page);
}

export const center = (r: { x: number; y: number; width: number; height: number }): XY => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
