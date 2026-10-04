import { describe, expect, it } from "vitest";
import { compileProject } from "../src/core/codegen";
import { executeCommand, listNodeTypes } from "../src/core/commands";
import { createProject, projectGraphs } from "../src/core/graph";
import { libraryCategories } from "../src/core/registry";
import { allTargets, getTarget, registerTarget, type ShaderTarget } from "../src/core/targets";

const glow: ShaderTarget = {
  id: "test-glow",
  label: "Glow",
  description: "A test function target.",
  base: "function",
  category: "Glow",
  inputs: [
    { key: "fresnel", label: "Fresnel", type: "float", description: "Rim factor." },
    { key: "uv", label: "UV", type: "vec2", description: "UV." },
  ],
  outputs: [{ key: "color", label: "Color", type: "vec4", description: "Linear RGBA." }],
  exportName: "glowShader",
  typeImports: [{ from: "three/webgpu", names: ["Node"] }],
  declarations: ["export type GlowShader = (inputs: { fresnel: Node; uv: Node }) => { color: Node | null };"],
  type: "GlowShader",
  starter(b) {
    const f = b.add("test-glow/fresnel", 0, 0);
    const out = b.add("test-glow/output", 300, 0);
    b.connect(f, "out", out, "color");
  },
};

const bolt: ShaderTarget = {
  id: "test-bolt",
  label: "Bolt material",
  description: "A test material target.",
  base: "material",
  category: "Bolt",
  inputs: [
    { key: "color", label: "Bolt Colour", type: "color", description: "Weapon colour.", default: "#ff4422" },
    { key: "pulse", label: "Pulse Rate", type: "float", description: "Pulses per second.", default: 2 },
  ],
  exportName: "createBoltMaterial",
  declarations: ["export interface BoltOptions { color?: string; pulse?: number }"],
  optionsType: "BoltOptions",
  starter(b) {
    const m = b.add("material/basic", 300, 0);
    const c = b.add("test-bolt/color", 0, 0);
    b.connect(c, "out", m, "colorNode");
  },
};

registerTarget(glow);
registerTarget(bolt);

describe("targets", () => {
  it("are registered next to the built-in particle target", () => {
    expect(allTargets().map((t) => t.id)).toEqual(expect.arrayContaining(["particle", "test-glow", "test-bolt"]));
    expect(getTarget("test-glow")).toBe(glow);
    expect(() => registerTarget({ ...glow, id: "Bad Id" })).toThrow(/Invalid target id/);
    expect(() => registerTarget({ ...glow, id: "no-outputs", outputs: [] })).toThrow(/needs outputs/);
    expect(() => createProject("x", "nope")).toThrow(/Unknown target "nope"/);
  });

  it("a function target compiles to a typed exported function", () => {
    const doc = createProject("g", "test-glow");
    expect(projectGraphs(doc)).toEqual(["function"]);
    const r = compileProject(doc);
    expect(r.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(r.code).toContain("import type { Node } from 'three/webgpu';");
    expect(r.code).toContain("export type GlowShader =");
    expect(r.code).toContain("export const glowShader: GlowShader = ({ fresnel: testGlowFresnel, uv: testGlowUv }) => {");
    expect(r.code).toMatch(/return \{ color: vec4\(_node\d+\) \};\n\};/);
    expect(r.code).toContain("export default glowShader;");
    expect(r.code).not.toMatch(/import \{[^}]*\buv\b/);
  });

  it("a material target compiles to a factory reading its options", () => {
    const doc = createProject("b", "test-bolt");
    expect(projectGraphs(doc)).toEqual(["material"]);
    const r = compileProject(doc);
    expect(r.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(r.code).toContain("export function createBoltMaterial(options: BoltOptions = {}) {");
    expect(r.code).toContain('  const testBoltColor = color(options.color ?? "#ff4422");');
    expect(r.code).toContain("  const testBoltPulse = float(options.pulse ?? 2);");
    expect(r.code).toMatch(/const (_node\d+) = testBoltColor;[\s\S]*material\.colorNode = \1;/);
    expect(r.code).toContain("  return material;\n}");
    expect(r.code).toContain("export default createBoltMaterial;");
    expect(r.code).not.toMatch(/RenderPipeline|renderer\.render/);
    // previews use the defaults
    expect(r.runtime.material).toContain('const testBoltColor = color("#ff4422");');
    expect(r.runtime.material).toMatch(/return \{ material: material,/);
  });

  it("target nodes only appear in their own projects", () => {
    expect(listNodeTypes({ graph: "material", target: "test-bolt" }).some((d) => d.type === "test-bolt/color")).toBe(true);
    expect(listNodeTypes({ graph: "material", target: "particle" }).some((d) => d.type === "test-bolt/color")).toBe(false);
    expect(libraryCategories("function", "test-glow").map((c) => c.name)).toContain("Glow");
    expect(libraryCategories("function", "particle").map((c) => c.name)).not.toContain("Glow");
    expect(() => executeCommand(createProject("p", "particle"), { op: "addNode", type: "test-glow/uv" })).toThrow(/belongs to the test-glow target/);
  });
});
