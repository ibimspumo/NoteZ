import { Show, type Component } from "solid-js";
import { type PaneId, closePane, totalPaneCount } from "../../stores/panes";
import { PinIcon } from "../icons";

type Props = {
  paneId: PaneId;
  title: string;
  isPinned: boolean;
};

export const PaneHeader: Component<Props> = (props) => {
  const handleClose = (e: MouseEvent) => {
    e.stopPropagation();
    closePane(props.paneId);
  };

  // The very last pane keeps its close button hidden - closing it would clear
  // the only editor and leave a stranded empty pane that the user has to fill
  // anyway. Just hide the affordance to avoid the dead-end interaction.
  const showClose = () => totalPaneCount() > 1;

  return (
    <div class="nz-pane-header">
      <span class="nz-pane-header-title">{props.title.trim() || "New note"}</span>
      <Show when={props.isPinned}>
        <span class="nz-pane-header-pin" aria-label="Pinned">
          <PinIcon width="10" height="10" fill="currentColor" />
        </span>
      </Show>
      <Show when={showClose()}>
        <button
          type="button"
          class="nz-pane-header-close"
          onClick={handleClose}
          aria-label="Close pane"
          title="Close pane · ⌘W"
        >
          ×
        </button>
      </Show>
    </div>
  );
};
