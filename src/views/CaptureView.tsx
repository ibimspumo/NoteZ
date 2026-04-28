import { onCleanup, onMount, type Component } from "solid-js";
import { emit } from "@tauri-apps/api/event";
import { api } from "../lib/tauri";
import { deriveTitle } from "../lib/format";

export const CaptureView: Component = () => {
  let textareaRef: HTMLTextAreaElement | undefined;

  const handleKey = async (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      await save();
    }
  };

  const save = async () => {
    if (!textareaRef) return;
    const text = textareaRef.value.trim();
    if (!text) {
      cancel();
      return;
    }
    const note = await api.createNote();
    const title = deriveTitle(text);
    const initialJson = textToParagraphState(text);
    await api.updateNote({
      id: note.id,
      title,
      content_json: JSON.stringify(initialJson),
      content_text: text,
      mention_target_ids: [],
      asset_ids: [],
    });
    await emit("notez://notes/changed", { id: note.id });
    textareaRef.value = "";
    await api.hideCaptureWindow();
  };

  const cancel = async () => {
    if (textareaRef) textareaRef.value = "";
    await api.hideCaptureWindow();
  };

  onMount(() => {
    setTimeout(() => textareaRef?.focus(), 0);
    window.addEventListener("keydown", handleKey);
    onCleanup(() => window.removeEventListener("keydown", handleKey));
  });

  return (
    <div class="nz-capture" data-tauri-drag-region>
      <span class="nz-capture-wordmark" aria-hidden="true">
        Note<span class="nz-capture-wordmark-z">Z</span>
      </span>
      <textarea
        ref={(el) => (textareaRef = el)}
        class="nz-capture-input"
        placeholder="Type a thought…"
        rows={3}
      />
      <div class="nz-capture-hints" data-tauri-drag-region aria-hidden="true">
        <span class="nz-capture-hint">
          <kbd>⌘</kbd>
          <kbd>↵</kbd>
          save
        </span>
        <span class="nz-capture-hint-sep">·</span>
        <span class="nz-capture-hint">
          <kbd>esc</kbd>
          dismiss
        </span>
      </div>
    </div>
  );
};

function textToParagraphState(text: string) {
  const lines = text.split("\n");
  const children = lines.map((line) => ({
    children: line
      ? [
          {
            detail: 0,
            format: 0,
            mode: "normal",
            style: "",
            text: line,
            type: "text",
            version: 1,
          },
        ]
      : [],
    direction: "ltr",
    format: "",
    indent: 0,
    type: "paragraph",
    version: 1,
    textFormat: 0,
    textStyle: "",
  }));
  return {
    root: {
      children,
      direction: "ltr",
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  };
}
