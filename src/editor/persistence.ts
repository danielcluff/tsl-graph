import type { ProjectDoc } from "../core/types";

export type SaveState = "saved" | "unsaved" | "saving" | "error" | "conflict";

// Timestamps and generated thumbnails are not authored changes. In particular,
// a background thumbnail must never authorize overwriting a newer graph.
function content(doc: ProjectDoc): string {
  const { updatedAt, thumbnail, ...rest } = doc;
  return JSON.stringify(rest);
}

/** Serializes focus checks and autosaves against the last version we loaded/saved. */
export function createPersistence(initial: ProjectDoc, hooks: {
  current(): ProjectDoc;
  load?(): Promise<ProjectDoc>;
  save(doc: ProjectDoc): Promise<void>;
  accept(doc: ProjectDoc): void;
  saved(doc: ProjectDoc): void;
  status(state: SaveState): void;
  conflict(active: boolean): void;
}) {
  let baseline = structuredClone(initial);
  let external: ProjectDoc | null = null;
  let tail = Promise.resolve();
  const dirty = () => content(hooks.current()) !== content(baseline);
  const status = () => hooks.status(external ? "conflict" : dirty() ? "unsaved" : "saved");
  function enqueue(run: () => Promise<void>) {
    tail = tail.then(run).catch(() => hooks.status("error"));
    return tail;
  }
  function accept(doc: ProjectDoc) {
    baseline = structuredClone(doc);
    external = null;
    hooks.accept(doc);
    hooks.conflict(false);
    status();
  }
  function conflict(doc: ProjectDoc) {
    external = doc;
    hooks.conflict(true);
    hooks.status("conflict");
  }
  async function check() {
    if (!hooks.load) return;
    const remote = await hooks.load();
    if (remote.updatedAt === baseline.updatedAt) return status();
    // Read dirty state AFTER the request: edits may have happened while loading.
    if (dirty() || external) conflict(remote);
    else accept(remote);
  }
  async function write() {
    if (external) return status();
    await check();
    if (external) return;
    const authored = dirty();
    if (!authored && hooks.current().thumbnail === baseline.thumbnail) return status();
    const submitted = structuredClone(hooks.current());
    submitted.updatedAt = authored ? Math.max(Date.now(), baseline.updatedAt + 1, submitted.updatedAt) : baseline.updatedAt;
    hooks.status("saving");
    await hooks.save(submitted);
    baseline = structuredClone(submitted);
    hooks.saved(submitted);
    // An edit made during the request is not saved by that request.
    status();
  }
  return {
    check: () => enqueue(check),
    save: () => enqueue(write),
    resolve: (choice: "reload" | "overwrite") => enqueue(async () => {
      if (!external || !hooks.load) return;
      const remote = await hooks.load();
      if (choice === "reload") return accept(remote);
      // Require another choice if the disk changed again while the alert was open.
      if (remote.updatedAt !== external.updatedAt) return conflict(remote);
      baseline = structuredClone(remote);
      external = null;
      hooks.conflict(false);
      await write();
    }),
  };
}
