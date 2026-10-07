// What the canvas does, through real mouse and keyboard input: the behaviour the graph UI must
// keep when its implementation changes (e.g. moving to solid-graph).
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import {
  canvasRect,
  center,
  closeBrowser,
  drag,
  edgePoints,
  emptyPoint,
  grabPoint,
  groupGrip,
  handlePoint,
  launch,
  nodeRect,
  openEditor,
  setViewport,
  settle,
  snapshot,
} from "./helpers";

let page: Awaited<ReturnType<typeof openEditor>>;

beforeEach(async () => {
  page = await openEditor();
});
afterEach(async () => {
  expect(page.errors).toEqual([]);
  await page.close();
});
afterAll(closeBrowser);

/** Drags node `id` by its header so that its centre lands on `target` (screen). */
async function dragCenterTo(id: string, target: { x: number; y: number }) {
  const r = await nodeRect(page, id);
  const g = await grabPoint(page, id);
  const c = center(r);
  await drag(page, g, { x: g.x + target.x - c.x, y: g.y + target.y - c.y });
}

const edgeInto = (s: Awaited<ReturnType<typeof snapshot>>, target: string, handle: string) =>
  s.edges.filter((e) => e.target === target && e.targetHandle === handle);

describe("moving nodes", () => {
  it("moves a node by the pointer delta divided by the zoom, to whole units", async () => {
    await setViewport(page, { x: 720, y: 220, zoom: 0.5 });
    const before = (await snapshot(page)).nodes.free;
    const g = await grabPoint(page, "free");
    await drag(page, g, { x: g.x + 101, y: g.y - 40 });
    const after = (await snapshot(page)).nodes.free;
    expect(after.x).toBe(before.x + 202);
    expect(after.y).toBe(before.y - 80);
  });

  it("records one undo step per drag", async () => {
    const s0 = await snapshot(page);
    const g = await grabPoint(page, "free");
    await drag(page, g, { x: g.x + 80, y: g.y + 30 }, { steps: 20 });
    const s1 = await snapshot(page);
    expect(s1.history).toBe(s0.history + 1);
    await page.evaluate(() => (window as any).__tsl.ed.undo());
    await settle(page);
    expect((await snapshot(page)).nodes.free).toEqual(s0.nodes.free);
  });

  it("selects a node when dragging it, and drags the whole selection", async () => {
    await page.evaluate(() => (window as any).__tsl.ed.select(["time", "col"]));
    await settle(page);
    const s0 = await snapshot(page);
    const g = await grabPoint(page, "time");
    await drag(page, g, { x: g.x + 50, y: g.y + 20 });
    const s1 = await snapshot(page);
    expect(s1.nodes.time.x - s0.nodes.time.x).toBe(50);
    expect(s1.nodes.col.x - s0.nodes.col.x).toBe(50);
    expect(s1.nodes.mul).toEqual(s0.nodes.mul);
    expect(s1.selection.nodes.sort()).toEqual(["col", "time"]);
  });

  it("drags a group by its frame, carrying its children", async () => {
    const s0 = await snapshot(page);
    const g = await groupGrip(page, "grp");
    await drag(page, g, { x: g.x + 60, y: g.y + 40 });
    const s1 = await snapshot(page);
    expect(s1.nodes.grp.x - s0.nodes.grp.x).toBe(60);
    expect(s1.nodes.inner.x - s0.nodes.inner.x).toBe(60);
    expect(s1.nodes.inner.y - s0.nodes.inner.y).toBe(40);
    expect(s1.nodes.inner.parentId).toBe("grp");
  });

  it("doesn't drag a group pressed inside its body (off the frame)", async () => {
    const s0 = await snapshot(page);
    const r = await nodeRect(page, "grp");
    const inner = await nodeRect(page, "inner");
    await drag(page, { x: inner.x - 30, y: r.y + r.height - 25 }, { x: inner.x + inner.width + 10, y: inner.y + 10 });
    const s1 = await snapshot(page);
    expect(s1.nodes.grp).toEqual(s0.nodes.grp);
    expect(s1.nodes.inner).toEqual(s0.nodes.inner);
  });

  it("box-selects from inside a group's body", async () => {
    const r = await nodeRect(page, "grp");
    const inner = await nodeRect(page, "inner");
    await drag(page, { x: inner.x - 30, y: r.y + r.height - 25 }, { x: inner.x + inner.width + 10, y: inner.y + 10 });
    // the box only partly covers the group: the group isn't selected
    expect((await snapshot(page)).selection.nodes).toEqual(["inner"]);
  });

  it("box-selects a group only when the box covers all of it", async () => {
    const r = await nodeRect(page, "grp");
    const start = await emptyPoint(page, { x: r.x - 30, y: r.y + r.height + 30 });
    await drag(page, start, { x: r.x + r.width + 20, y: r.y - 60 });
    expect((await snapshot(page)).selection.nodes.sort()).toEqual(["grp", "inner"]);
  });
});

describe("containers", () => {
  it("adopts a node dropped into a group and releases it when dragged out", async () => {
    await dragCenterTo("free", center(await nodeRect(page, "grp2")));
    expect((await snapshot(page)).nodes.free.parentId).toBe("grp2");
    const out = await emptyPoint(page, { x: 1100, y: 150 });
    await dragCenterTo("free", out);
    expect((await snapshot(page)).nodes.free.parentId).toBeUndefined();
  });

  it("doesn't nest groups, or put comments in groups", async () => {
    await dragCenterTo("cmt", center(await nodeRect(page, "grp2")));
    expect((await snapshot(page)).nodes.cmt.parentId).toBeUndefined();
    // a group dropped onto another group stays top-level
    const g = await groupGrip(page, "grp");
    const target = center(await nodeRect(page, "grp2"));
    const r = await nodeRect(page, "grp");
    await drag(page, g, { x: g.x + target.x - center(r).x, y: g.y + target.y - center(r).y });
    const s = await snapshot(page);
    expect(s.nodes.grp.parentId).toBeUndefined();
    expect(s.nodes.inner.parentId).toBe("grp");
  });

  it("resizes a group from its corner, down to a minimum size", async () => {
    const s0 = await snapshot(page);
    const r = await nodeRect(page, "grp");
    const corner = { x: r.x + r.width - 5, y: r.y + r.height - 5 };
    await drag(page, corner, { x: corner.x + 60, y: corner.y + 40 });
    let s = await snapshot(page);
    expect(s.nodes.grp.width).toBe(s0.nodes.grp.width! + 60);
    expect(s.nodes.grp.height).toBe(s0.nodes.grp.height! + 40);
    const r2 = await nodeRect(page, "grp");
    const corner2 = { x: r2.x + r2.width - 5, y: r2.y + r2.height - 5 };
    await drag(page, corner2, { x: corner2.x - 1000, y: corner2.y - 1000 });
    s = await snapshot(page);
    expect(s.nodes.grp.width).toBe(200);
    expect(s.nodes.grp.height).toBe(120);
  });
});

describe("connections", () => {
  it("connects an output to an input", async () => {
    await drag(page, await handlePoint(page, "time", "out", "out"), await handlePoint(page, "free", "in", "a"));
    expect(edgeInto(await snapshot(page), "free", "a")).toMatchObject([{ source: "time", sourceHandle: "out" }]);
  });

  it("connects from an input to an output", async () => {
    await drag(page, await handlePoint(page, "free", "in", "b"), await handlePoint(page, "col", "out", "r"));
    expect(edgeInto(await snapshot(page), "free", "b")).toMatchObject([{ source: "col", sourceHandle: "r" }]);
  });

  it("snaps to a handle near the drop point", async () => {
    const h = await handlePoint(page, "free", "in", "b");
    await drag(page, await handlePoint(page, "time", "out", "out"), { x: h.x - 14, y: h.y + 10 });
    expect(edgeInto(await snapshot(page), "free", "b")).toMatchObject([{ source: "time" }]);
  });

  it("replaces the wire of an input that already has one", async () => {
    await drag(page, await handlePoint(page, "col", "out", "out"), await handlePoint(page, "mul", "in", "a"));
    // pressing a connected input picks its wire up instead, so this connects from col's side
    const s = await snapshot(page);
    expect(edgeInto(s, "mul", "a")).toMatchObject([{ source: "col", sourceHandle: "out" }]);
  });

  it("rejects a connection that would make a cycle", async () => {
    const s0 = await snapshot(page);
    await drag(page, await handlePoint(page, "mul", "out", "out"), await handlePoint(page, "col", "in", "value"));
    const s1 = await snapshot(page);
    expect(s1.edges).toEqual(s0.edges);
  });

  it("picks up a connected wire from its input, undoably", async () => {
    const s0 = await snapshot(page);
    const from = await handlePoint(page, "mul", "in", "a");
    await drag(page, from, await emptyPoint(page, { x: from.x - 60, y: from.y + 120 }));
    const s1 = await snapshot(page);
    expect(edgeInto(s1, "mul", "a")).toEqual([]);
    // the loose end came from `time`: dropping it on the canvas offers to add a node connected to it
    expect(s1.picker?.from).toMatchObject({ nodeId: "time", side: "out", key: "out" });
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as any).__tsl.ed.undo());
    await settle(page);
    expect((await snapshot(page)).edges).toEqual(s0.edges);
  });

  it("opens the node picker for a wire dropped on empty canvas", async () => {
    const from = await handlePoint(page, "free", "out", "out");
    await drag(page, from, await emptyPoint(page, { x: from.x + 150, y: from.y - 120 }));
    const s = await snapshot(page);
    expect(s.picker?.from).toMatchObject({ nodeId: "free", side: "out", key: "out" });
  });

  it("draws each edge from its source handle to its target handle", async () => {
    const check = async () => {
      const s = await snapshot(page);
      for (const e of s.edges) {
        const p = await edgePoints(page, e.id);
        const a = await handlePoint(page, e.source, "out", e.sourceHandle);
        const b = await handlePoint(page, e.target, "in", e.targetHandle);
        expect(Math.abs(p.start.y - a.y), `${e.id} start y`).toBeLessThan(1.5);
        expect(Math.abs(p.start.x - a.x), `${e.id} start x`).toBeLessThanOrEqual(a.width / 2 + 1);
        expect(Math.abs(p.end.y - b.y), `${e.id} end y`).toBeLessThan(1.5);
        expect(Math.abs(p.end.x - b.x), `${e.id} end x`).toBeLessThanOrEqual(b.width / 2 + 1);
      }
    };
    await check();
    await setViewport(page, { x: 500, y: 300, zoom: 0.55 });
    await check();
    const g = await grabPoint(page, "mul");
    await drag(page, g, { x: g.x + 70, y: g.y + 90 });
    await check();
  });
});

describe("selection", () => {
  it("selects on click, toggles with shift-click and clears on empty canvas", async () => {
    const click = async (id: string, shift = false) => {
      const p = await grabPoint(page, id);
      if (shift) await page.keyboard.down("Shift");
      await page.mouse.click(p.x, p.y);
      if (shift) await page.keyboard.up("Shift");
      await settle(page);
    };
    await click("time");
    expect((await snapshot(page)).selection.nodes).toEqual(["time"]);
    await click("col", true);
    expect((await snapshot(page)).selection.nodes).toEqual(["time", "col"]);
    await click("time", true);
    expect((await snapshot(page)).selection.nodes).toEqual(["col"]);
    const empty = await emptyPoint(page, { x: 1200, y: 120 });
    await page.mouse.click(empty.x, empty.y);
    await settle(page);
    expect((await snapshot(page)).selection.nodes).toEqual([]);
  });

  it("box-selects the nodes it touches, adding to the selection with shift", async () => {
    const t = await nodeRect(page, "time");
    const c = await nodeRect(page, "col");
    const start = await emptyPoint(page, { x: t.x - 40, y: t.y - 40 });
    await drag(page, start, { x: c.x + 20, y: c.y + 20 });
    let s = await snapshot(page);
    expect(s.selection.nodes.sort()).toEqual(["col", "time"]);
    const f = await nodeRect(page, "free");
    const start2 = await emptyPoint(page, { x: f.x + f.width + 30, y: f.y - 30 });
    await drag(page, start2, { x: f.x + f.width - 10, y: f.y + 10 }, { shift: true });
    s = await snapshot(page);
    expect(s.selection.nodes.sort()).toEqual(["col", "free", "time"]);
  });

  it("selects an edge on click and deletes it with the Delete key", async () => {
    const { mid } = await edgePoints(page, "mul-material.colorNode");
    await page.mouse.click(mid.x, mid.y);
    await settle(page);
    expect((await snapshot(page)).selection.edges).toEqual(["mul-material.colorNode"]);
    await page.keyboard.press("Delete");
    await settle(page);
    expect((await snapshot(page)).edges.map((e) => e.id)).not.toContain("mul-material.colorNode");
  });
});

describe("menus", () => {
  it("right-click on a node selects it and opens its context menu", async () => {
    const p = await grabPoint(page, "mul");
    await page.mouse.click(p.x, p.y, { button: "right" });
    await settle(page);
    const s = await snapshot(page);
    expect(s.selection.nodes).toEqual(["mul"]);
    expect(s.context).toMatchObject({ kind: "node", id: "mul" });
  });

  it("right-click on empty canvas opens the canvas menu", async () => {
    const p = await emptyPoint(page, { x: 1200, y: 120 });
    await page.mouse.click(p.x, p.y, { button: "right" });
    await settle(page);
    expect((await snapshot(page)).context).toMatchObject({ kind: "canvas" });
  });

  it("double-click on empty canvas opens the node picker", async () => {
    const p = await emptyPoint(page, { x: 1200, y: 120 });
    await page.mouse.dblclick(p.x, p.y);
    await settle(page);
    const s = await snapshot(page);
    expect(s.picker).not.toBeNull();
    expect(s.picker?.from).toBeUndefined();
  });

  it("adds a node dropped from the sidebar where it was dropped", async () => {
    const p = await emptyPoint(page, { x: 1200, y: 150 });
    const id = await page.evaluate((p) => {
      const { ed } = (window as any).__tsl;
      const target = document.elementFromPoint(p.x, p.y)!;
      const dt = new DataTransfer();
      dt.setData("application/x-tsl-node", "math/sin");
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, dataTransfer: dt }));
      return ed.graph().nodes.find((n: any) => n.type === "math/sin")?.id;
    }, p);
    expect(id).toBeTruthy();
    const s = await snapshot(page);
    // the node's top-left is offset so the pointer lands near its header
    expect(s.nodes[id].x).toBe(Math.round(p.x - (await canvasRect(page)).x - s.viewport.x - 90));
  });
});

describe("viewport", () => {
  it("zooms around the pointer with the wheel", async () => {
    const at = await emptyPoint(page, { x: 900, y: 500 });
    const flow = (pt: { x: number; y: number }) => page.evaluate((pt) => (window as any).__tsl.ed.screenToFlow(pt.x, pt.y), pt);
    const before = await flow(at);
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -200);
    await settle(page);
    const s = await snapshot(page);
    expect(s.viewport.zoom).toBeGreaterThan(1);
    const after = await flow(at);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  it("pans with a horizontal trackpad scroll", async () => {
    const at = await emptyPoint(page, { x: 900, y: 500 });
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(30, 5);
    await settle(page);
    expect((await snapshot(page)).viewport).toEqual({ x: 690, y: 215, zoom: 1 });
  });

  it("pans with space-drag, even starting on a node, without moving it", async () => {
    const s0 = await snapshot(page);
    const g = await grabPoint(page, "mul");
    await page.keyboard.down("Space");
    await drag(page, g, { x: g.x + 100, y: g.y + 50 });
    await page.keyboard.up("Space");
    const s1 = await snapshot(page);
    expect(s1.viewport).toEqual({ x: 820, y: 270, zoom: 1 });
    expect(s1.nodes.mul).toEqual(s0.nodes.mul);
  });

  it("space-drag doesn't press the button that has focus when Space is released", async () => {
    const expanded = () => page.evaluate(() => (window as any).__tsl.ui.previewExpanded() as boolean);
    const toggle = page.getByRole("button", { name: "Toggle expanded preview" });
    // expand and collapse with the mouse: the button keeps focus
    await toggle.click();
    await toggle.click();
    await settle(page);
    expect(await expanded()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Toggle expanded preview");
    const from = await emptyPoint(page, { x: 900, y: 500 });
    await page.keyboard.down("Space");
    await drag(page, from, { x: from.x + 80, y: from.y + 40 });
    await page.keyboard.up("Space");
    await settle(page);
    expect((await snapshot(page)).viewport).toEqual({ x: 800, y: 260, zoom: 1 });
    expect(await expanded()).toBe(false);
  });

  it("Space still presses a focused button when nothing is dragged", async () => {
    const expanded = () => page.evaluate(() => (window as any).__tsl.ui.previewExpanded() as boolean);
    await page.getByRole("button", { name: "Toggle expanded preview" }).focus();
    await page.keyboard.press("Space");
    await settle(page);
    expect(await expanded()).toBe(true);
  });

  it("pans with a middle-button drag", async () => {
    const g = await grabPoint(page, "mul");
    await drag(page, g, { x: g.x - 40, y: g.y + 30 }, { button: "middle" });
    expect((await snapshot(page)).viewport).toEqual({ x: 680, y: 250, zoom: 1 });
  });

  it("fits every node in view", async () => {
    await page.keyboard.press("KeyF");
    await settle(page);
    const c = await canvasRect(page);
    for (const id of Object.keys((await snapshot(page)).nodes)) {
      const r = await nodeRect(page, id);
      expect(r.x, id).toBeGreaterThanOrEqual(c.x - 1);
      expect(r.y, id).toBeGreaterThanOrEqual(c.y - 1);
      expect(r.x + r.width, id).toBeLessThanOrEqual(c.x + c.width + 1);
      expect(r.y + r.height, id).toBeLessThanOrEqual(c.y + c.height + 1);
    }
  });

  it("keeps a viewport per graph", async () => {
    await setViewport(page, { x: 11, y: 22, zoom: 0.7 });
    await page.evaluate(() => (window as any).__tsl.ed.setGraph("post"));
    await settle(page);
    await setViewport(page, { x: -5, y: 9, zoom: 1.3 });
    await page.evaluate(() => (window as any).__tsl.ed.setGraph("material"));
    await settle(page);
    expect((await snapshot(page)).viewport).toEqual({ x: 11, y: 22, zoom: 0.7 });
  });
});

describe("NodeCard outside the editor", () => {
  it("renders a static card with its ports", async () => {
    const p: Page = await (await launch()).newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${inject("baseUrl")}/e2e.html?static=1`);
    await p.waitForSelector("#static-card");
    const text = await p.textContent("#static-card");
    expect(text).toMatch(/Mul|Multiply/i);
    expect(errors).toEqual([]);
    await p.close();
  });
});
