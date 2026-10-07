import { describe, expect, it, vi } from "vitest";
import { createProject } from "../src/core/graph";
import { createPersistence, type SaveState } from "../src/editor/persistence";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function setup() {
  let disk = { ...createProject("initial"), updatedAt: 10 };
  let local = structuredClone(disk);
  let state: SaveState = "saved";
  let conflict = false;
  const load = vi.fn(async () => structuredClone(disk));
  const save = vi.fn(async (doc: typeof disk) => { disk = structuredClone(doc); });
  const accept = vi.fn((doc: typeof disk) => { local = structuredClone(doc); });
  const p = createPersistence(local, {
    current: () => local, load, save, accept,
    saved: (doc) => { local.updatedAt = doc.updatedAt; },
    status: (s) => { state = s; }, conflict: (c) => { conflict = c; },
  });
  return { p, load, save, accept, get local() { return local; }, get disk() { return disk; }, get state() { return state; }, get conflict() { return conflict; } };
}

describe("editor persistence", () => {
  it("reloads a clean tab when the stored timestamp differs, including older restored files", async () => {
    const s = setup(); s.disk.name = "restored"; s.disk.updatedAt = 9;
    await s.p.check();
    expect(s.local.name).toBe("restored"); expect(s.accept).toHaveBeenCalledOnce(); expect(s.save).not.toHaveBeenCalled();
    await s.p.check(); expect(s.accept).toHaveBeenCalledOnce();
  });
  it("does not reload an unchanged revision", async () => {
    const s = setup(); await s.p.check(); expect(s.accept).not.toHaveBeenCalled();
  });
  it("warns about local changes and blocks autosaves until a choice is made", async () => {
    const s = setup(); s.local.name = "local"; s.disk.name = "remote"; s.disk.updatedAt++;
    await s.p.check(); await s.p.save(); await s.p.save();
    expect(s.conflict).toBe(true); expect(s.state).toBe("conflict"); expect(s.local.name).toBe("local"); expect(s.disk.name).toBe("remote"); expect(s.save).not.toHaveBeenCalled();
    await s.p.resolve("reload"); expect(s.local.name).toBe("remote"); expect(s.state).toBe("saved"); expect(s.conflict).toBe(false);
  });
  it("detects a conflict before an autosave even without a focus event", async () => {
    const s = setup(); s.local.name = "local"; s.disk.updatedAt++;
    await s.p.save(); expect(s.save).not.toHaveBeenCalled(); expect(s.conflict).toBe(true);
  });
  it("can explicitly keep local edits, then treats the saved revision as the baseline", async () => {
    const s = setup(); s.local.name = "local"; s.disk.updatedAt++;
    await s.p.check(); await s.p.resolve("overwrite");
    expect(s.disk.name).toBe("local"); expect(s.state).toBe("saved");
    await s.p.check(); expect(s.conflict).toBe(false); expect(s.accept).not.toHaveBeenCalled();
  });
  it("does not overwrite a third version that arrived while the alert was open", async () => {
    const s = setup(); s.local.name = "local"; s.disk.updatedAt++;
    await s.p.check(); s.disk.name = "newer"; s.disk.updatedAt++;
    await s.p.resolve("overwrite"); expect(s.save).not.toHaveBeenCalled(); expect(s.conflict).toBe(true); expect(s.disk.name).toBe("newer");
  });
  it("notices edits made while the focus check is awaiting its response", async () => {
    const s = setup(); const response = deferred<typeof s.disk>();
    s.load.mockImplementationOnce(() => response.promise);
    const pending = s.p.check(); await Promise.resolve();
    s.local.name = "typed during load";
    response.resolve({ ...s.disk, updatedAt: 11 }); await pending;
    expect(s.conflict).toBe(true); expect(s.local.name).toBe("typed during load"); expect(s.accept).not.toHaveBeenCalled();
  });
  it("keeps edits made during a save dirty and serializes a focus check behind it", async () => {
    const s = setup(); const response = deferred<void>(); const started = deferred<void>();
    s.save.mockImplementationOnce(async doc => { started.resolve(); await response.promise; Object.assign(s.disk, doc); });
    s.local.name = "first"; const pending = s.p.save(); await started.promise;
    s.local.name = "second"; const check = s.p.check(); response.resolve(); await pending; await check;
    expect(s.state).toBe("unsaved"); expect(s.local.name).toBe("second"); expect(s.conflict).toBe(false);
    await s.p.save(); expect(s.disk.name).toBe("second"); expect(s.state).toBe("saved");
  });
  it("does not let automatic thumbnails overwrite a newer graph", async () => {
    const s = setup(); s.local.thumbnail = "new thumbnail"; s.local.updatedAt++;
    s.disk.name = "other tab"; s.disk.updatedAt = 20;
    await s.p.save(); expect(s.local.name).toBe("other tab"); expect(s.save).not.toHaveBeenCalled();
  });
  it("still saves thumbnails without changing the authored revision", async () => {
    const s = setup(); s.local.thumbnail = "new thumbnail"; s.local.updatedAt++;
    await s.p.save(); expect(s.disk.thumbnail).toBe("new thumbnail"); expect(s.disk.updatedAt).toBe(10); expect(s.state).toBe("saved");
  });
  it("fails closed on a failed freshness check and can retry", async () => {
    const s = setup(); s.local.name = "local"; s.load.mockRejectedValueOnce(new Error("offline"));
    await s.p.save(); expect(s.state).toBe("error"); expect(s.save).not.toHaveBeenCalled();
    await s.p.save(); expect(s.disk.name).toBe("local");
  });
  it("does not lose edits or advance the baseline when saving fails", async () => {
    const s = setup(); s.local.name = "local"; s.save.mockRejectedValueOnce(new Error("disk full"));
    await s.p.save(); expect(s.state).toBe("error"); expect(s.disk.name).toBe("initial");
    await s.p.save(); expect(s.disk.name).toBe("local");
  });
});
