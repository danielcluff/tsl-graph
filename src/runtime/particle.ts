/// <reference path="../types.d.ts" />
// Particle shaders: evaluating a particle graph (ProjectDoc.kind "particle")
// with its inputs bound to real nodes.
//
//  - createParticleShader(doc) gives the function elate-particles calls for a
//    sprite renderer with `material: { kind: "graph", shaderId }` (pass it via
//    ParticleWorldOptions.shaders); the inputs are the sprite's attributes.
//  - The editor preview binds the same inputs to a cloud of test sprites, and
//    node thumbnails to a grid of sprites by age (particleThumbnailInputs).
import * as THREE from "three/webgpu";
import {
  cameraProjectionMatrix,
  clamp,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  length,
  mix,
  modelViewMatrix,
  positionGeometry,
  pow,
  sin,
  time,
  uv,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import { compileProject, PARTICLE_INPUTS } from "../core/codegen";
import { normalizeDoc } from "../core/graph";
import type { Diagnostic, ProjectDoc } from "../core/types";
import { runtimeScope } from "./scope";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** Per-particle nodes a particle graph reads (the elate-particles ParticleShaderInputs). */
export interface ParticleInputs {
  /** Normalised age 0..1. */
  age: Node;
  /** Per-particle random 0..1. */
  seed: Node;
  /** Lifetime in seconds. */
  life: Node;
  /** World velocity (vec3). */
  velocity: Node;
  /** Base colour × colour over life (vec4, linear). */
  color: Node;
  /** Sprite UV (vec2). */
  uv: Node;
  /** Shape mask / texture sample (vec4). */
  shape: Node;
}

/** What a particle graph produces; null keeps the renderer's own (colour × shape). */
export interface ParticleOutputs {
  color: Node | null;
  opacity: Node | null;
}

export interface ParticleGraphResult extends ParticleOutputs {
  nodes: Record<string, unknown>;
  uniforms: Record<string, { value: unknown }>;
}

/** Evaluate a compiled particle body (CompileResult.runtime.particle) with `inputs` bound. */
export function evaluateParticle(body: string, inputs: ParticleInputs): ParticleGraphResult {
  const { keys, values } = runtimeScope();
  const fn = new Function(...keys, ...PARTICLE_INPUTS.map((i) => i.ident), body);
  return fn(...values, ...PARTICLE_INPUTS.map((i) => inputs[i.key]));
}

export interface ParticleShader {
  /** Builds the graph's nodes for one material (called once per sprite material the runtime creates). */
  (inputs: ParticleInputs): Partial<ParticleOutputs>;
}

/**
 * A particle shader project as the function elate-particles calls. Compiles
 * once; each call evaluates the graph for one material. `diagnostics` holds
 * compile errors; a graph that fails to evaluate leaves the renderer's own
 * look (and reports through `onError`).
 */
export function createParticleShader(
  doc: ProjectDoc,
  onError?: (message: string) => void,
): { shader: ParticleShader; diagnostics: Diagnostic[]; ok: boolean } {
  const compiled = compileProject(normalizeDoc(structuredClone(doc)));
  const ok = compiled.particle.ok && !compiled.diagnostics.some((d) => d.level === "error");
  const body = compiled.runtime.particle;
  const shader: ParticleShader = (inputs) => {
    if (!ok) return {};
    try {
      const r = evaluateParticle(body, inputs);
      return { color: r.color, opacity: r.opacity };
    } catch (err) {
      onError?.(`${doc.name}: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  };
  return { shader, diagnostics: compiled.diagnostics, ok };
}

// ---------------------------------------------------------------------------
// preview bindings
// ---------------------------------------------------------------------------

/** The preview's stand-in particle colour: warm, so colour edits are easy to see. */
const PREVIEW_COLOR = vec4(1, 0.62, 0.28, 1);

/** The renderer's default soft-circle mask at sprite UV `p`. */
function softCircle(p: Node): Node {
  const d = length(p.sub(0.5)).mul(2);
  return vec4(vec3(1), pow(clamp(float(1).sub(d), 0, 1), 1.5));
}

/** Rows × columns of sprites in node thumbnails, ordered by age (left to right, top to bottom). */
export const THUMBNAIL_GRID = 3;

/**
 * Inputs for node thumbnails: the quad shows a 3×3 grid of sprites whose age
 * runs from ~0 (top left) to ~1 (bottom right), each with its own seed, so a
 * thumbnail shows how a node's value changes over a particle's life.
 */
export function particleThumbnailInputs(): ParticleInputs {
  const n = THUMBNAIL_GRID;
  const g = uv().mul(n);
  const cell = floor(g);
  // thumbnails are read back with uv.y = 0 at the top
  const index = cell.x.add(cell.y.mul(n));
  const local = fract(g);
  const seed = fract(sin(index.mul(12.9898).add(4.1414)).mul(43758.5453));
  return {
    age: index.add(0.5).div(n * n),
    seed,
    life: mix(1.2, 2.4, seed),
    velocity: vec3(seed.sub(0.5), 1.5, float(0.5).sub(seed)),
    color: PREVIEW_COLOR,
    uv: local,
    shape: softCircle(local),
  };
}

/**
 * A fountain of camera-facing test sprites for the preview, with the particle
 * graph applied (additive, like the runtime's default sprite).
 */
export function createParticleCloud(count = 320): THREE.InstancedMesh {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, count);
  mesh.frustumCulled = false;
  mesh.name = "particle-preview";
  return mesh;
}

/** Rebuilds the cloud's material for a compiled particle body. Returns the graph's uniforms (for live edits). */
export function applyParticleCloud(mesh: THREE.InstancedMesh, body: string): ParticleGraphResult["uniforms"] {
  const i = float(instanceIndex);
  const seed = hash(i);
  const life = mix(1.1, 2.2, hash(i.add(17)));
  const age = fract(time.div(life).add(seed));
  const velocity = vec3(hash(i.add(3)).sub(0.5).mul(1.4), mix(1.6, 2.6, hash(i.add(5))), hash(i.add(7)).sub(0.5).mul(1.4));
  const t = age.mul(life);
  // rise and fall under a little gravity, from just below the centre
  const pos = vec3(0, -1.2, 0).add(velocity.mul(t)).add(vec3(0, -0.9, 0).mul(t.mul(t)));
  const size = mix(0.28, 0.5, hash(i.add(11)));
  const center = modelViewMatrix.mul(vec4(pos, 1)).xyz;
  const corner = positionGeometry.xy.mul(size);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  material.side = THREE.DoubleSide;
  material.vertexNode = cameraProjectionMatrix.mul(vec4(center.add(vec3(corner, 0)), 1));

  const color = PREVIEW_COLOR;
  const shape = softCircle(uv());
  const inputs: ParticleInputs = {
    age: varying(age),
    seed: varying(seed),
    life: varying(life),
    velocity: varying(velocity),
    color,
    uv: uv(),
    shape,
  };
  const r = evaluateParticle(body, inputs);
  material.colorNode = r.color ?? color.xyz.mul(shape.xyz);
  material.opacityNode = clamp(r.opacity ?? color.w.mul(shape.w), 0, 1);
  const old = mesh.material as THREE.Material;
  mesh.material = material;
  old.dispose();
  return r.uniforms;
}
