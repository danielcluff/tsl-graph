// Browser entry: the graph editor as a Solid component, or mounted into any
// DOM element for hosts that don't use Solid.
import { render } from "@solidjs/web";
import { GraphEditor, type GraphEditorProps } from "./GraphEditor";

export { GraphEditor, type GraphEditorProps } from "./GraphEditor";
export type { GraphHost, McpMode, ProjectSource, ProviderId } from "../host";
export type { Theme } from "../ui/theme";

export interface MountedGraphEditor {
  dispose(): void;
}

/**
 * Mount the editor into `el` (it fills the element). To switch projects,
 * dispose and mount again with the new `projectId`.
 */
export function mountGraphEditor(el: HTMLElement, props: GraphEditorProps): MountedGraphEditor {
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  const dispose = render(() => <GraphEditor {...props} />, el);
  return { dispose };
}
