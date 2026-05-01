import { type Component, For, Show } from "solid-js";
import { type LeafPane, activePaneId, dragNoteId, setActivePaneId } from "../../stores/panes";
import { PaneDropOverlay } from "./PaneDropOverlay";
import { PaneHeader } from "./PaneHeader";
import { PaneTabStrip } from "./PaneTabStrip";
import { TabContent } from "./TabContent";

type Props = {
  pane: LeafPane;
  /** Whether to show pane chrome (title row or tab strip). False when the
   *  whole layout has just one pane and that pane has just one tab - then
   *  the editor renders flush like the original single-pane look. */
  showChrome: boolean;
  onOpenNote: (id: string, opts?: { split: boolean }) => void;
  onCreate: () => Promise<void>;
};

/**
 * A single leaf pane in the layout. Renders its tabs:
 *
 * - 1 tab + chrome hidden          → no header, no strip (single-pane mode)
 * - 1 tab + chrome shown           → PaneHeader with note title
 * - 2+ tabs (any layout)           → PaneTabStrip replaces the header
 *
 * All tabs render simultaneously - inactive ones get `display: none` via
 * `classList.active`. Each tab owns its own Lexical instance and save pipeline
 * (mounted in TabContent), so switching tabs is a CSS visibility flip with no
 * remount, no editor flash, and preserved cursor/scroll/undo per tab.
 */
export const EditorPane: Component<Props> = (props) => {
  // mousedown wins over click for activation - the mention-popover and other
  // inner components stop click propagation, but the mousedown bubbles first.
  const handleActivate = () => setActivePaneId(props.pane.id);

  const tabsCount = () => props.pane.tabs.length;
  const showStrip = () => tabsCount() > 1;
  // The plain header shows when there's just one tab in this pane AND the
  // overall layout has chrome enabled. Without the multi-pane condition we'd
  // be drawing chrome in single-pane single-tab mode (the canonical clean
  // look that should look identical to pre-tabs / pre-splits NoteZ).
  const showHeader = () => !showStrip() && props.showChrome;

  const activeTab = () => props.pane.tabs[props.pane.activeTabIdx];

  return (
    <div
      class="nz-pane"
      classList={{
        active: activePaneId() === props.pane.id,
        // Only mark "this pane needs an active-state ring" when the layout
        // actually has more than one pane. With a single pane, there's no
        // ambiguity about where the user is - the accent border is just
        // visual noise.
        "multi-pane": props.showChrome,
      }}
      onMouseDown={handleActivate}
      onFocusIn={handleActivate}
    >
      <Show when={showStrip()}>
        <PaneTabStrip pane={props.pane} onCreate={props.onCreate} />
      </Show>
      <Show when={showHeader()}>
        <PaneHeader paneId={props.pane.id} noteId={activeTab().noteId} />
      </Show>
      <div class="nz-pane-tabs-host">
        <For each={props.pane.tabs}>
          {(tab) => (
            <div
              class="nz-tab-content"
              classList={{ active: tab.id === activeTab().id }}
              data-tab-id={tab.id}
            >
              <TabContent
                paneId={props.pane.id}
                tabId={tab.id}
                noteId={tab.noteId}
                isActive={tab.id === activeTab().id}
                onOpenNote={props.onOpenNote}
                onCreate={props.onCreate}
              />
            </div>
          )}
        </For>
      </div>
      <Show when={dragNoteId() !== null}>
        <PaneDropOverlay paneId={props.pane.id} />
      </Show>
    </div>
  );
};
