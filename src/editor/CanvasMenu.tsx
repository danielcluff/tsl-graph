import { For, Show, createMemo, createSignal, onCleanup, useContext } from "solid-js";
import { FileCode2, LayoutGrid, Repeat, Scan, Search, X } from "lucide-static";
import type { NodeDef, XY } from "../core/types";
import { Icon, MenuItem, MenuSeparator } from "../ui";
import { addableNodeDefs, groupedMatches } from "./node-search";
import { SHORTCUTS } from "./shortcuts";
import { EditorContext } from "./store";
import { ui } from "./ui-state";

/**
 * Right-click menu on empty canvas. A search field sits on top and has focus
 * when the menu opens; typing swaps the menu for the original editor's
 * command-style node list (grouped by category, first match highlighted,
 * Enter adds it at the click point). Clearing the field keeps the list,
 * unfiltered, for browsing; × or Escape returns to the menu.
 *
 * `bindEscape` hands the popover an Escape handler that steps back to the
 * menu instead of closing (returns true when it did).
 */
export function CanvasMenu(props: { screen: XY; bindEscape: (fn: (() => boolean) | undefined) => void }) {
  const ed = useContext(EditorContext);
  const [query, setQuery] = createSignal("");
  /** Showing the node list (entered by typing; stays when the query is cleared). */
  const [searching, setSearching] = createSignal(false);
  const [active, setActive] = createSignal(0);
  let input: HTMLInputElement | undefined;
  const at = () => ed.screenToFlow(props.screen.x, props.screen.y);
  const run = (fn: () => void) => () => {
    ui.closeMenus();
    fn();
  };

  const groups = createMemo(() => (searching() ? groupedMatches(addableNodeDefs(ed), query()) : []));
  /** Results in display order, for keyboard navigation. */
  const flat = createMemo(() => groups().flatMap((g) => g.nodes));

  const backToMenu = () => {
    setQuery("");
    setSearching(false);
    setActive(0);
    input?.focus();
  };
  props.bindEscape(() => {
    if (!searching()) return false;
    backToMenu();
    return true;
  });
  onCleanup(() => props.bindEscape(undefined));

  const add = (def: NodeDef) => {
    const p = at();
    ui.closeMenus();
    if (def.kind === "loop") ed.createLoop(p);
    else ed.addNodeAt(def.type, p);
  };

  let list: HTMLDivElement | undefined;
  const move = (i: number) => {
    // like cmdk: no wrap-around at either end
    const next = Math.max(0, Math.min(flat().length - 1, i));
    setActive(next);
    list?.querySelector(`[data-i="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return; // the popover handles it (through bindEscape)
    e.stopPropagation();
    if (!searching()) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(active() + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(active() - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(flat().length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const def = flat()[active()];
      if (def) add(def);
    }
  };

  return (
    <>
      <div class={["relative -mx-1 -mt-1 flex h-9 items-center gap-2 border-b px-3", !searching() && "mb-1", searching() && "pr-9"]}>
        <Icon svg={Search} class="size-4 shrink-0 opacity-50" />
        <input
          ref={(el) => {
            input = el;
            requestAnimationFrame(() => el.focus());
          }}
          class="flex h-10 w-full min-w-0 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
          placeholder={searching() ? "Back" : "Search nodes..."}
          aria-label="Search nodes"
          role="combobox"
          aria-expanded={searching() ? "true" : "false"}
          autocomplete="off"
          spellcheck={false}
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            if (e.currentTarget.value) setSearching(true);
            setActive(0);
            if (list) list.scrollTop = 0;
          }}
          onKeyDown={onKeyDown}
        />
        <Show when={searching()}>
          {/* empty field: the placeholder reads "Back", with its key alongside like a menu shortcut */}
          <Show when={!query()}>
            <span class="pointer-events-none shrink-0 text-xs tracking-widest text-muted-foreground">Esc</span>
          </Show>
          <button
            type="button"
            aria-label="Back to menu"
            title="Back to menu (Esc)"
            class="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm opacity-50 hover:bg-accent hover:opacity-100"
            onPointerDown={(e) => e.preventDefault()}
            onClick={backToMenu}
          >
            <Icon svg={X} class="size-4" />
          </button>
        </Show>
      </div>

      <Show
        when={searching()}
        fallback={
          <>
            <MenuItem shortcut={SHORTCUTS.paste.display} onSelect={run(() => void ed.paste(at()))}>
              Paste
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={FileCode2} onSelect={run(() => ed.addNodeAt("code/tsl", at()))}>
              Create Code Node
            </MenuItem>
            <MenuItem icon={Repeat} onSelect={run(() => ed.createLoop(at()))}>
              Create Loop
            </MenuItem>
            <MenuItem onSelect={run(() => ed.addNodeAt("utils/comment", at()))}>Add Comment</MenuItem>
            <MenuSeparator />
            <MenuItem icon={Scan} onSelect={run(() => ed.fitView())}>
              Fit View
            </MenuItem>
            <MenuItem icon={LayoutGrid} onSelect={run(() => ed.autoLayout())}>
              Auto Layout
            </MenuItem>
          </>
        }
      >
        <div ref={list} role="listbox" aria-label="Nodes" class="thin-scroll -mx-1 -mb-1 max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto">
          <For each={groups()} fallback={<div class="py-6 text-center text-sm">No nodes found.</div>}>
            {(g) => (
              <div class="overflow-hidden p-1 text-foreground">
                <div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{g.category}</div>
                <For each={g.nodes}>
                  {(d) => {
                    // rows are reused across queries, so the position is derived
                    const index = createMemo(() => flat().indexOf(d));
                    const selected = () => active() === index();
                    return (
                      <div
                        role="option"
                        data-i={index()}
                        aria-selected={selected() ? "true" : "false"}
                        class={[
                          "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none",
                          selected() && "bg-accent text-accent-foreground",
                        ]}
                        onPointerMove={() => void (!selected() && setActive(index()))}
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => add(d)}
                      >
                        <span>{d.label}</span>
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
