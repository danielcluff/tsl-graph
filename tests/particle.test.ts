import { describe, expect, it } from "vitest";
import { compileProject, PARTICLE_INPUTS } from "../src/core/codegen";
import { executeCommand } from "../src/core/commands";
import { createProject, normalizeDoc, projectGraphs } from "../src/core/graph";
import { listNodeTypes } from "../src/core/commands";
import { projectFromTemplate } from "../src/core/templates";

const errors = (doc: Parameters<typeof compileProject>[0]) => compileProject(doc).diagnostics.filter((d) => d.level === "error");

describe("particle graph kind", () => {
  it("starts as colour × shape and compiles to a particleShader function", () => {
    const doc = createProject("p", "particle");
    expect(projectGraphs(doc)).toEqual(["particle"]);
    const r = compileProject(doc);
    expect(errors(doc)).toEqual([]);
    expect(r.code).toContain("export function particleShader({ age: particleAge, seed: particleSeed, life: particleLife, velocity: particleVelocity, color: particleColor, uv: particleUv, shape: particleShape }) {");
    expect(r.code).toMatch(/return \{ color: vec3\(_node\d+\), opacity: float\(_node\d+\) \};/);
    // inputs are parameters, never imported
    expect(r.code).not.toMatch(/import \{[^}]*particleAge/);
    expect(r.runtime.particle).toMatch(/const _node\d+ = particleColor;/);
    expect(r.runtime.particle).toMatch(/_node\d+\.rgb/);
    expect(r.runtime.particle).toMatch(/return \{ color: .*, nodes: \{/);
    expect(r.particle).toMatchObject({ ok: true, color: true, opacity: true });
    // the material/post graphs aren't compiled for a particle project
    expect(r.runtime.material).toBe("return { material: null, nodes: {}, uniforms: {} };");
  });

  it("leaves an unconnected output to the renderer", () => {
    const doc = createProject("p", "particle");
    const out = doc.graphs.particle.nodes.find((n) => n.type === "particle/output")!;
    executeCommand(doc, { op: "disconnect", target: out.id, targetHandle: "color" });
    const r = compileProject(doc);
    expect(r.particle).toMatchObject({ color: false, opacity: true });
    expect(r.runtime.particle).toMatch(/return \{ color: null, opacity: float/);
  });

  it("reports a missing output", () => {
    const doc = createProject("p", "particle");
    executeCommand(doc, { op: "clearGraph" });
    expect(errors(doc).map((d) => d.message)).toContain("Particle Output is missing");
  });

  it("defaults commands to the particle graph and keeps material-only nodes out", () => {
    const doc = createProject("p", "particle");
    const r = executeCommand(doc, { op: "addNode", type: "particle/seed" }) as { nodeId: string };
    expect(doc.graphs.particle.nodes.some((n) => n.id === r.nodeId)).toBe(true);
    expect(() => executeCommand(doc, { op: "addNode", type: "material/standard" })).toThrow(/material graph/);
    expect(() => executeCommand(doc, { op: "addNode", type: "math/add", graph: "post" })).toThrow(/no "post" graph/);
    // and particle inputs stay out of material projects
    expect(() => executeCommand(createProject("m"), { op: "addNode", type: "particle/age" })).toThrow(/particle graph/);
    expect(listNodeTypes({ graph: "particle" }).some((d) => d.type === "particle/age")).toBe(true);
    expect(listNodeTypes({ graph: "material" }).some((d) => d.type === "particle/age")).toBe(false);
  });

  it("builds the particle templates without errors", () => {
    for (const id of ["particle", "particle-hot-core"]) {
      const doc = projectFromTemplate(id);
      expect(doc.kind).toBe("particle");
      expect(errors(doc), id).toEqual([]);
      expect(compileProject(doc).particle, id).toMatchObject({ color: true, opacity: true });
    }
  });

  it("adds the particle graph to older projects", () => {
    const doc = createProject("m");
    delete (doc.graphs as Partial<typeof doc.graphs>).particle;
    expect(normalizeDoc(doc).graphs.particle).toEqual({ nodes: [], edges: [] });
    expect(PARTICLE_INPUTS.map((i) => i.ident)).toContain("particleAge");
  });
});
