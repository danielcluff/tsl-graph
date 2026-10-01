import { createSignal } from "solid-js";

// The editor's colour scheme. Applied as classes on the editor root and on
// every portal (dialogs, menus, toasts), so it never touches the host page.

export type Theme = "dark" | "light";

// written by GraphEditor while rendering (from its `theme` prop)
const [theme, setTheme] = createSignal<Theme>("dark", { ownedWrite: true });
export { theme, setTheme };

/** Classes for any element that hosts editor UI outside the editor root. */
export const rootClass = () => `tsl-graph-root${theme() === "dark" ? " tsl-dark" : ""}`;
