import { emit } from "@tauri-apps/api/event";
import { type Component, Show, createSignal, onCleanup, onMount } from "solid-js";
import zIcon from "../assets/Z.svg";
import { deriveTitle } from "../lib/format";
import { api } from "../lib/tauri";

type Status = "idle" | "saving" | "generating";

export const CaptureView: Component = () => {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [status, setStatus] = createSignal<Status>("idle");
  const [error, setError] = createSignal<string | null>(null);

  const isBusy = () => status() !== "idle";

  const handleKey = async (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // While the AI call is in flight, ignore Escape - we don't want a
      // half-saved note. Once it lands (success or fail), Escape works again.
      if (isBusy()) return;
      cancel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (isBusy()) return;
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

    setError(null);
    setStatus("saving");

    // Read AI config fresh from the DB - the capture window is its own JS
    // heap, so the in-memory settings store can be stale relative to changes
    // the user just made in the main window.
    let useAi = false;
    try {
      const cfg = await api.getAiConfig();
      useAi = cfg.enabled && cfg.has_key;
    } catch (e) {
      console.warn("getAiConfig failed:", e);
    }

    // Compute the AI title BEFORE persisting. On success we prepend it as
    // the editor's first paragraph (the editor styles paragraph 1 as title,
    // Apple-Notes-style); on failure or when AI is off, we let the user's
    // first line serve as the visual title and use deriveTitle for the
    // sidebar's `title` column.
    let title = deriveTitle(text);
    let aiTitle: string | null = null;
    if (useAi) {
      setStatus("generating");
      try {
        const generated = await api.generateTitle(text);
        if (generated && generated.trim().length > 0) {
          aiTitle = generated.trim();
          title = aiTitle;
        }
      } catch (e) {
        console.warn("ai title gen failed, using fallback:", e);
      }
      setStatus("saving");
    }

    try {
      const note = await api.createNote();
      const initialJson = textToParagraphState(text, aiTitle);
      const contentText = aiTitle ? `${aiTitle}\n${text}` : text;
      await api.updateNote({
        id: note.id,
        title,
        content_json: JSON.stringify(initialJson),
        content_text: contentText,
        mention_target_ids: [],
        asset_ids: [],
      });
      await emit("notez://notes/changed", { id: note.id });
      textareaRef.value = "";
      setStatus("idle");
      await api.hideCaptureWindow();
    } catch (e) {
      setStatus("idle");
      setError(String(e));
    }
  };

  const cancel = async () => {
    if (textareaRef) textareaRef.value = "";
    setError(null);
    setStatus("idle");
    await api.hideCaptureWindow();
  };

  onMount(() => {
    setTimeout(() => textareaRef?.focus(), 0);
    window.addEventListener("keydown", handleKey);
    onCleanup(() => window.removeEventListener("keydown", handleKey));
  });

  return (
    <div class="nz-capture" classList={{ busy: isBusy() }} data-tauri-drag-region>
      <img class="nz-capture-icon" src={zIcon} alt="" aria-hidden="true" />
      <textarea
        ref={(el) => (textareaRef = el)}
        class="nz-capture-input"
        placeholder="Type a thought…"
        rows={3}
        disabled={isBusy()}
      />
      <div class="nz-capture-hints" data-tauri-drag-region aria-hidden="true">
        <Show
          when={status() === "generating"}
          fallback={
            <Show
              when={status() === "saving"}
              fallback={
                <Show when={!error()} fallback={<span class="nz-capture-error">{error()}</span>}>
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
                </Show>
              }
            >
              <span class="nz-capture-status">
                <span class="nz-capture-spinner" aria-hidden="true" />
                Saving…
              </span>
            </Show>
          }
        >
          <span class="nz-capture-status">
            <span class="nz-capture-spinner" aria-hidden="true" />
            Generating title…
          </span>
        </Show>
      </div>
    </div>
  );
};

// Build the Lexical editor state. If `titleLine` is set, it becomes the first
// paragraph (the editor renders paragraph 1 as title); otherwise the user's
// first line of `text` plays that role. We never duplicate: the user's full
// text is preserved verbatim either way.
function textToParagraphState(text: string, titleLine: string | null) {
  const lines = titleLine ? [titleLine, ...text.split("\n")] : text.split("\n");
  const children = lines.map(makeParagraph);
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

function makeParagraph(line: string) {
  return {
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
  };
}
