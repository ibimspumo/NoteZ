import { type Component, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import type { MentionStatus } from "../../lib/types";

type Props = {
  status: Extract<MentionStatus, "trashed" | "missing">;
  rect: DOMRect;
  onRemove: () => void;
  onConvert: () => void;
  onClose: () => void;
};

/**
 * Two-action popover shown when the user clicks a mention whose target is
 * trashed or missing. Anchored under the mention pill itself - same
 * positioning rule as the live mention search popover.
 *
 * Actions:
 *   - Remove: delete the mention node entirely.
 *   - Convert to text: replace the pill with plain `@<old-title>` text.
 *
 * Both actions are reversible via the editor's own undo (the underlying
 * Lexical history records the node removal/replacement), so we don't add a
 * confirmation step.
 */
export const BrokenMentionPopover: Component<Props> = (props) => {
  // Click-outside / Escape close. The mousedown listener runs on the
  // capture phase so it pre-empts any other handler that might steal the
  // event (the editor itself, the mention click handler).
  createEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".nz-broken-mention-popover")) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    });
  });

  const positionStyle = () => {
    const r = props.rect;
    return {
      left: `${r.left}px`,
      top: `${r.bottom + 6}px`,
    };
  };

  const headline = () =>
    props.status === "trashed" ? "Linked note is in Trash" : "Linked note no longer exists";

  return (
    <Portal>
      <div class="nz-broken-mention-popover" style={positionStyle()}>
        <div class="nz-broken-mention-headline">{headline()}</div>
        <button
          type="button"
          class="nz-broken-mention-action"
          onClick={() => {
            props.onRemove();
            props.onClose();
          }}
        >
          Remove
        </button>
        <button
          type="button"
          class="nz-broken-mention-action"
          onClick={() => {
            props.onConvert();
            props.onClose();
          }}
        >
          Convert to text
        </button>
      </div>
    </Portal>
  );
};
