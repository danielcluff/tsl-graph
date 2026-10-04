import { describe, expect, it } from "vitest";
import { compileProject, PARTICLE_INPUTS } from "../src/core/codegen";
import { executeCommand } from "../src/core/commands";
import { createProject, normalizeDoc, projectGraphs } from "../src/core/graph";
import { listNodeTypes } from "../src/core/commands";
import { projectFromTemplate } from "../src/core/templates";
import type { ProjectDoc } from "../src/core/types";

const errors = (doc: Parameters<typeof compileProject>[0]) => compileProject(doc).diagnostics.filter((d) => d.level === "error");

describe("particle target", () => {
  it("starts as colour × shape and compiles to a particleShader function", () => {
    const doc = createProject("p", "particle");
    expect(doc.target).toBe("particle");
    expect(projectGraphs(doc)).toEqual(["function"]);
    const r = compileProject(doc);
    expect(errors(doc)).toEqual([]);
    expect(r.code).toContain("export function particleShader({ age: particleAge, seed: particleSeed, life: particleLife, velocity: particleVelocity, color: particleColor, uv: particleUv, shape: particleShape }) {");
    expect(r.code).toMatch(/return \{ color: vec3\(_node\d+\), opacity: float\(_node\d+\) \};/);
    expect(r.code).toContain("export default particleShader;");
    // only what's used is imported: object keys (color:, uv:) aren't references
    expect(r.code).toContain("import { float, mul, vec3 } from 'three/tsl';");
    expect(r.runtime.function).toMatch(/const _node\d+ = particleColor;/);
    expect(r.runtime.function).toMatch(/return \{ color: .*, nodes: \{/);
    expect(r.function).toMatchObject({ ok: true, connected: { color: true, opacity: true } });
    // the material/post graphs aren't compiled for a function project
    expect(r.runtime.material).toBe("return { material: null, nodes: {}, uniforms: {} };");
  });

  it("returns null for an unconnected output", () => {
    const doc = createProject("p", "particle");
    const out = doc.graphs.function.nodes.find((n) => n.type === "particle/output")!;
    executeCommand(doc, { op: "disconnect", target: out.id, targetHandle: "color" });
    const r = compileProject(doc);
    expect(r.function.connected).toEqual({ color: false, opacity: true });
    expect(r.runtime.function).toMatch(/return \{ color: null, opacity: float/);
  });

  it("reports a missing output", () => {
    const doc = createProject("p", "particle");
    executeCommand(doc, { op: "clearGraph" });
    expect(errors(doc).map((d) => d.message)).toContain("Particle Output is missing");
  });

  it("defaults commands to the function graph and keeps other nodes out", () => {
    const doc = createProject("p", "particle");
    const r = executeCommand(doc, { op: "addNode", type: "particle/seed" }) as { nodeId: string };
    expect(doc.graphs.function.nodes.some((n) => n.id === r.nodeId)).toBe(true);
    expect(() => executeCommand(doc, { op: "addNode", type: "material/standard" })).toThrow(/material graph/);
    expect(() => executeCommand(doc, { op: "addNode", type: "math/add", graph: "post" })).toThrow(/no "post" graph/);
    // and particle inputs stay out of material projects
    expect(() => executeCommand(createProject("m"), { op: "addNode", type: "particle/age" })).toThrow(/function graph/);
    expect(listNodeTypes({ graph: "function", target: "particle" }).some((d) => d.type === "particle/age")).toBe(true);
    expect(listNodeTypes({ graph: "material" }).some((d) => d.type === "particle/age")).toBe(false);
  });

  it("builds the particle templates without errors", () => {
    for (const id of ["particle", "particle-hot-core"]) {
      const doc = projectFromTemplate(id);
      expect(doc.target).toBe("particle");
      expect(errors(doc), id).toEqual([]);
      expect(compileProject(doc).function.connected, id).toEqual({ color: true, opacity: true });
    }
  });

  it("migrates particle projects from before targets", () => {
    const fresh = createProject("p", "particle");
    const old = { ...structuredClone(fresh), kind: "particle", graphs: { material: fresh.graphs.material, post: fresh.graphs.post, particle: fresh.graphs.function } } as unknown as ProjectDoc;
    delete (old as Partial<ProjectDoc>).target;
    const doc = normalizeDoc(old);
    expect(doc.target).toBe("particle");
    expect("kind" in doc).toBe(false);
    expect("particle" in doc.graphs).toBe(false);
    expect(doc.graphs.function.nodes).toHaveLength(5);
    expect(errors(doc)).toEqual([]);
    expect(PARTICLE_INPUTS.map((i) => i.ident)).toContain("particleAge");
    // plain materials get an empty function graph
    const m = createProject("m");
    delete (m.graphs as Partial<typeof m.graphs>).function;
    expect(normalizeDoc(m).graphs.function).toEqual({ nodes: [], edges: [] });
  });
});
