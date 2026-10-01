import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createProject, nodeCount, normalizeDoc } from "../core/graph";
import type { ProjectDoc, ProjectSummary } from "../core/types";
import type { ProjectStore } from "../host";

// A ProjectStore that keeps one JSON file per project in a directory. Handy
// for local tools and the playground; host apps usually bring their own.

const ID = /^[a-zA-Z0-9_-]{1,64}$/;

export interface FileStore extends ProjectStore {
  remove(id: string): Promise<void>;
}

export function createFileStore(dir: string): FileStore {
  const root = resolve(dir);
  const file = (id: string) => {
    if (!ID.test(id)) throw new Error(`Invalid project id "${id}"`);
    return join(root, `${id}.json`);
  };
  const ensure = () => mkdir(root, { recursive: true });

  async function save(doc: ProjectDoc) {
    await ensure();
    const target = file(doc.id);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, target);
  }

  return {
    async list(): Promise<ProjectSummary[]> {
      await ensure();
      const out: ProjectSummary[] = [];
      for (const f of (await readdir(root)).filter((f) => f.endsWith(".json"))) {
        try {
          const doc = JSON.parse(await readFile(join(root, f), "utf8")) as ProjectDoc;
          out.push({ id: doc.id, name: doc.name, createdAt: doc.createdAt, updatedAt: doc.updatedAt, thumbnail: doc.thumbnail, nodeCount: nodeCount(doc) });
        } catch {
          // skip unreadable files
        }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id) {
      try {
        return normalizeDoc(JSON.parse(await readFile(file(id), "utf8")) as ProjectDoc);
      } catch {
        return null;
      }
    },
    save,
    async create(name, from) {
      const doc = createProject(name || "Untitled");
      if (from) {
        if (from.graphs) doc.graphs = from.graphs;
        if (from.globals) doc.globals = from.globals;
        if (from.customNodes) doc.customNodes = from.customNodes;
        if (from.settings) doc.settings = { ...doc.settings, ...from.settings };
        if (from.thumbnail) doc.thumbnail = from.thumbnail;
      }
      await save(doc);
      return doc;
    },
    async remove(id) {
      await rm(file(id), { force: true });
    },
  };
}
