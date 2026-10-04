// Targets: the contract a project's generated module follows.
//
// A target says what a graph can read (its inputs), what it produces, and how
// the exported module looks, so the module drops into the code that uses it:
//
//  - "function" targets: one graph from the target's inputs to its outputs,
//    exported as a function (e.g. the built-in "particle" target: elate-particles
//    calls it per sprite material with the particle's age, colour, UV, …).
//  - "material" targets: the material graph, exported as a factory
//    `(options) => material`; the target's inputs are the factory's options
//    (e.g. a weapon's colour).
//
// Host apps register their own targets (registerTarget) next to the built-in
// particle target. Inputs become nodes in the target's category; a function
// target also gets an output node. Nothing here touches three or the DOM.
import type { DataType, PortDef } from "./types";

export interface TargetPort {
  key: string;
  label: string;
  type: DataType;
  description: string;
}

export interface TargetInput extends TargetPort {
  /** Extra outputs on the input node (swizzles), e.g. rgb / w of a vec4. */
  outputs?: { key: string; label: string; type: DataType }[];
  /**
   * Material targets: the option's default (also what previews use). A
   * colour is a "#rrggbb" string, a vector an array.
   */
  default?: number | string | number[];
}

export interface ShaderTarget {
  /** Stable id, stored in projects (`ProjectDoc.target`). */
  id: string;
  label: string;
  description: string;
  base: "function" | "material";
  /** Node library category for the target's nodes, e.g. "Particle". */
  category: string;
  inputs: TargetInput[];
  /** Function targets: what the graph produces (the output node's ports). Unconnected ports return null. */
  outputs?: TargetPort[];
  /** Name of the exported function (also the default export). */
  exportName: string;
  /** Identifier prefix for inputs in generated code (default: the id in camelCase), e.g. particle → particleAge. */
  prefix?: string;
  /** Module lines after the imports: type declarations, notes. */
  declarations?: string[];
  /** Type-only imports the declarations or `type` need. */
  typeImports?: { from: string; names: string[] }[];
  /** Function targets: the exported function's type (declared or imported). Untyped when omitted. */
  type?: string;
  /** Material targets: the options parameter's type (declared or imported). */
  optionsType?: string;
  /** Lines at the top of the module (e.g. how to use it). */
  header?: string[];
  /** Builds a new project's starting graph. */
  starter?: (b: StarterBuilder) => void;
}

/** What a target's starter uses to build the first graph. */
export interface StarterBuilder {
  /** Add a node to the project's main graph; returns its id. `activeInputs`: a material node's inputs to compile beyond its defaults. */
  add(type: string, x: number, y: number, values?: Record<string, unknown>, activeInputs?: string[]): string;
  connect(source: string, sourceHandle: string, target: string, targetHandle: string): void;
}

const targets = new Map<string, ShaderTarget>();
const listeners = new Set<() => void>();

const camel = (s: string) => s.replace(/[-_.\s]+(\w)/g, (_, c: string) => c.toUpperCase());
const pascal = (s: string) => camel(s).replace(/^\w/, (c) => c.toUpperCase());

/** The identifier an input compiles to, e.g. particle/age → particleAge. */
export function targetInputIdent(target: ShaderTarget, key: string): string {
  return `${target.prefix ?? camel(target.id)}${pascal(key)}`;
}

export const targetInputType = (target: ShaderTarget, key: string) => `${target.id}/${key}`;
export const targetOutputType = (target: ShaderTarget) => `${target.id}/output`;

/**
 * Register (or replace) a target. Its nodes appear in projects of that
 * target. Register before loading projects that use it, in every place that
 * compiles them (browser and server).
 */
export function registerTarget(target: ShaderTarget): void {
  if (!/^[a-z][a-z0-9-]*$/.test(target.id)) throw new Error(`Invalid target id "${target.id}" (lowercase-kebab-case)`);
  if (target.base === "function" && !target.outputs?.length) throw new Error(`Function target "${target.id}" needs outputs`);
  targets.set(target.id, target);
  for (const fn of listeners) fn();
}

export function getTarget(id: string | undefined): ShaderTarget | undefined {
  return id === undefined ? undefined : targets.get(id);
}

export function allTargets(): ShaderTarget[] {
  return [...targets.values()];
}

/** @internal the node registry rebuilds target nodes when targets change. */
export function onTargetsChanged(fn: () => void): void {
  listeners.add(fn);
}

/** Node definitions for a target: one per input, plus the output node of a function target. */
export function targetNodeDefs(target: ShaderTarget): import("./types").NodeDef[] {
  const graph = target.base === "function" ? "function" : "material";
  const port = (key: string, label: string, type: string, extra: Partial<PortDef> = {}): PortDef => ({ key, label, type, ...extra });
  const defs: import("./types").NodeDef[] = target.inputs.map((i) => ({
    type: targetInputType(target, i.key),
    label: i.label,
    category: target.category,
    description: target.base === "material" ? `${i.description} (option "${i.key}"; default ${JSON.stringify(i.default)})` : i.description,
    tsl: targetInputIdent(target, i.key),
    pure: true,
    kind: "targetInput",
    graphs: [graph],
    targets: [target.id],
    inputs: [],
    outputs: [port("out", i.label, i.type), ...(i.outputs ?? []).map((o) => port(o.key, o.label, o.type))],
  }));
  if (target.base === "function")
    defs.push({
      type: targetOutputType(target),
      label: `${target.category} Output`,
      category: target.category,
      description: `What the ${target.label.toLowerCase()} produces. ${target.outputs!.map((o) => `${o.label}: ${o.description}`).join(" ")}`,
      kind: "targetOutput",
      graphs: ["function"],
      targets: [target.id],
      inputs: target.outputs!.map((o) => port(o.key, o.label, o.type, { connectionOnly: true })),
      outputs: [],
    });
  return defs;
}

// ---------------------------------------------------------------------------
// built-in: elate-particles sprite shaders
// ---------------------------------------------------------------------------

export const PARTICLE_TARGET: ShaderTarget = {
  id: "particle",
  label: "Particle shader",
  description: "The look of each particle of an elate-particles sprite renderer (material: { kind: \"graph\", shaderId }).",
  base: "function",
  category: "Particle",
  inputs: [
    { key: "age", label: "Particle Age", type: "float", description: "Normalised age: 0 at birth, 1 at death." },
    { key: "seed", label: "Particle Seed", type: "float", description: "A random number in 0..1, fixed for the particle's life." },
    { key: "life", label: "Particle Life", type: "float", description: "Lifetime in seconds." },
    { key: "velocity", label: "Particle Velocity", type: "vec3", description: "World velocity (units per second)." },
    {
      key: "color",
      label: "Particle Color",
      type: "vec4",
      description: "The particle's colour × colour over life (linear RGBA).",
      outputs: [
        { key: "rgb", label: "RGB", type: "vec3" },
        { key: "w", label: "Alpha", type: "float" },
      ],
    },
    { key: "uv", label: "Sprite UV", type: "vec2", description: "UV across the sprite (after flipbook mapping)." },
    {
      key: "shape",
      label: "Sprite Shape",
      type: "vec4",
      description: "The renderer's shape mask or texture sample (RGBA; rgb is white for procedural shapes).",
      outputs: [
        { key: "rgb", label: "RGB", type: "vec3" },
        { key: "w", label: "Alpha", type: "float" },
      ],
    },
  ],
  outputs: [
    { key: "color", label: "Color", type: "vec3", description: "Each particle's colour; unconnected keeps the renderer's own (colour × shape)." },
    { key: "opacity", label: "Opacity", type: "float", description: "Each particle's opacity; unconnected keeps the renderer's own." },
  ],
  exportName: "particleShader",
  header: [
    "// Give it to elate-particles: new ParticleWorld({ shaders: (id) => (id === SHADER_ID ? particleShader : undefined) })",
    "// A null `color` / `opacity` keeps the renderer's own (colour × shape).",
  ],
  starter(b) {
    // the default look: the particle's colour, masked by its sprite shape
    const color = b.add("particle/color", 80, 120);
    const shape = b.add("particle/shape", 80, 300);
    const rgb = b.add("math/mul", 340, 140);
    const alpha = b.add("math/mul", 340, 300);
    const out = b.add("particle/output", 600, 200);
    b.connect(color, "rgb", rgb, "a");
    b.connect(shape, "rgb", rgb, "b");
    b.connect(color, "w", alpha, "a");
    b.connect(shape, "w", alpha, "b");
    b.connect(rgb, "out", out, "color");
    b.connect(alpha, "out", out, "opacity");
  },
};

registerTarget(PARTICLE_TARGET);
