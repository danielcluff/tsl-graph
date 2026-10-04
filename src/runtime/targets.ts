/// <reference path="../types.d.ts" />
// Function targets at runtime: evaluating a compiled function graph with its
// inputs bound to real nodes, and how the editor previews each target.
import type * as THREE from "three/webgpu";
import { compileProject } from "../core/codegen";
import { normalizeDoc } from "../core/graph";
import { getTarget, targetInputIdent, type ShaderTarget } from "../core/targets";
import type { Diagnostic, ProjectDoc } from "../core/types";
import { runtimeScope } from "./scope";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export interface FunctionGraphResult {
  /** The target's outputs; null when the port is unconnected. */
  outputs: Record<string, Node | null>;
  nodes: Record<string, unknown>;
  uniforms: Record<string, { value: unknown }>;
}

/** Evaluate a compiled function body (CompileResult.runtime.function) with `inputs` bound (by input key). */
export function evaluateTarget(target: ShaderTarget, body: string, inputs: Record<string, Node>): FunctionGraphResult {
  const { keys, values } = runtimeScope();
  const fn = new Function(...keys, ...target.inputs.map((i) => targetInputIdent(target, i.key)), body);
  const r = fn(...values, ...target.inputs.map((i) => inputs[i.key]));
  const { nodes, uniforms, ...outputs } = r as Record<string, unknown> & Pick<FunctionGraphResult, "nodes" | "uniforms">;
  return { outputs: outputs as Record<string, Node | null>, nodes, uniforms };
}

/**
 * A function-target project as the function its consumer calls (inputs →
 * outputs). Compiles once; each call builds the graph's nodes. A graph that
 * fails to evaluate returns no outputs (and reports through `onError`).
 */
export function createTargetFunction(
  doc: ProjectDoc,
  onError?: (message: string) => void,
): { fn: (inputs: Record<string, Node>) => Record<string, Node | null>; diagnostics: Diagnostic[]; ok: boolean; target: ShaderTarget | undefined } {
  const project = normalizeDoc(structuredClone(doc));
  const target = getTarget(project.target);
  const compiled = compileProject(project);
  const ok = !!target && target.base === "function" && compiled.function.ok && !compiled.diagnostics.some((d) => d.level === "error");
  const body = compiled.runtime.function;
  const fn = (inputs: Record<string, Node>) => {
    if (!ok || !target) return {};
    try {
      return evaluateTarget(target, body, inputs).outputs;
    } catch (err) {
      onError?.(`${doc.name}: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  };
  return { fn, diagnostics: compiled.diagnostics, ok, target };
}

// ---------------------------------------------------------------------------
// previews
// ---------------------------------------------------------------------------

export interface TargetPreviewContext {
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** The preview's own mesh (its geometry follows the project's preview settings). Hidden while a target preview shows. */
  mesh: THREE.Mesh;
}

/** How the editor previews a function target. */
export interface TargetPreview {
  /**
   * Build the preview object with the graph applied. `evaluate` runs the
   * graph for a set of inputs. `previous` is what this returned last time
   * (reuse or dispose it). The object is added to the scene in place of the
   * mesh. Return the graph's uniforms so value edits apply live.
   */
  apply(evaluate: (inputs: Record<string, Node>) => FunctionGraphResult, previous: THREE.Object3D | undefined, ctx: TargetPreviewContext): {
    object: THREE.Object3D;
    uniforms: Record<string, { value: unknown }>;
  };
  /** Inputs for node thumbnails (rendered on a quad with uv 0..1, y down). */
  thumbnailInputs(): Record<string, Node>;
  /** The preview always moves (e.g. particles age), so render continuously. */
  animated?: boolean;
  /** Called before the object is removed (switching away from the target). */
  dispose?(object: THREE.Object3D): void;
}

const previews = new Map<string, TargetPreview>();

/** Register how the editor previews a function target (browser only). */
export function registerTargetPreview(id: string, preview: TargetPreview): void {
  previews.set(id, preview);
}

export function getTargetPreview(id: string | undefined): TargetPreview | undefined {
  return id === undefined ? undefined : previews.get(id);
}
