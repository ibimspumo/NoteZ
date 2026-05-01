import { $createParagraphNode, $getRoot, $isParagraphNode, type LexicalEditor } from "lexical";
import { type Component, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { stringifyEditorState } from "../../lib/editorStringify";
import { api } from "../../lib/tauri";
import type { MentionStatus } from "../../lib/types";
import { getMentionStatus } from "../../stores/mentionRegistry";
import { toast } from "../../stores/toasts";
import type { EditorSnapshot } from "../../views/useSavePipeline";
import { BrokenMentionPopover } from "./BrokenMentionPopover";
import { MentionPopover } from "./MentionPopover";
import {
  createNoteZEditor,
  getEditorStateSnapshot,
  getPlainText,
  loadEditorStateFromJSON,
} from "./lexical/createEditor";
import { collectAssetIds } from "./lexical/imageNode";
import {
  type MentionClickOpts,
  attachMentionClickHandler,
  collectMentionTargets,
  convertMentionToTextByDOM,
  removeMentionByDOM,
} from "./lexical/mentionNode";
import { type MentionMatch, insertMention, registerMentionPlugin } from "./lexical/mentionPlugin";
import { registerMentionStatusDecorator } from "./lexical/mentionStatusDecorator";
import {
  type SerializedSelection,
  captureSelection,
  restoreSelection,
} from "./lexical/selectionPath";

// Per-note cursor persistence used to live in the kitchen-sink `settings`
// table under `cursor:<uuid>` keys. As of migration v7 it moved to a
// dedicated `cursors` table accessed via api.getCursor / api.setCursor -
// which keeps `list_settings` O(1) regardless of how many notes the user
// has touched. The migration backfilled the existing keys.
const PERSIST_DEBOUNCE_MS = 800;

export type EditorChange = {
  /**
   * Compute the full save payload - JSON state, plain text, mention targets,
   * asset ids. Deferred so the cost only lands once per save, not once per
   * keystroke. JSON.stringify runs in a worker.
   *
   * Returns `null` if the editor is gone (note unmounted between schedule and call).
   */
  snapshot: () => Promise<EditorSnapshot | null>;
};

type EditorProps = {
  noteId: string;
  initialJson: string;
  onChange: (change: EditorChange) => void;
  onOpenNote: (noteId: string, opts?: MentionClickOpts) => void;
  onReady?: (editor: LexicalEditor | null) => void;
  /** Called when the editor enters or leaves recovery mode (parse failure
   *  on load). The host is expected to suspend the save pipeline while
   *  recovery is active so a "looks empty" editor state cannot overwrite
   *  on-disk content the user has just been told is broken-but-recoverable. */
  onRecoveryChange?: (isRecovering: boolean) => void;
};

export const Editor: Component<EditorProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let editorRef: LexicalEditor | undefined;
  let lastNoteId: string | null = null;
  let suppressChange = false;
  // Per-note cursor memory so switching between notes lands the caret where
  // the user left it. The map is the in-session cache; persistence lives in
  // the `settings` table (key `cursor:<noteId>`) for cross-restart restore.
  const selectionsByNote = new Map<string, SerializedSelection>();
  let liveSelection: SerializedSelection | null = null;
  let persistTimer: number | null = null;

  const flushPersist = () => {
    persistTimer = null;
    const id = lastNoteId;
    const sel = liveSelection;
    if (!id || !sel) return;
    void api.setCursor(id, JSON.stringify(sel)).catch((e) => {
      console.warn("failed to persist cursor", e);
    });
  };
  const schedulePersist = () => {
    if (persistTimer != null) clearTimeout(persistTimer);
    persistTimer = window.setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
  };

  const [activeMatch, setActiveMatch] = createSignal<MentionMatch | null>(null);
  const [brokenMention, setBrokenMention] = createSignal<{
    el: HTMLElement;
    rect: DOMRect;
    status: Extract<MentionStatus, "trashed" | "missing">;
  } | null>(null);
  const [isEmpty, setIsEmpty] = createSignal(true);
  // Recovery mode: set when initial state load fails to parse. The save
  // pipeline is suspended while this is true (the host gates on it via
  // `onRecoveryChange`), and the editor surface shows a banner so the user
  // knows their note is *not* lost - it's just refusing to overwrite
  // possibly-corrupted but on-disk content with whatever blank state Lexical
  // happens to be in right now.
  const [recovering, setRecovering] = createSignal(false);
  let confirmFn: (() => boolean) | null = null;
  let navigateFn: ((dir: "up" | "down") => void) | null = null;

  createEffect(() => {
    if (!containerRef) return;
    const handles = createNoteZEditor(containerRef);
    editorRef = handles.editor;
    props.onReady?.(handles.editor);

    const cleanupClick = attachMentionClickHandler(containerRef, {
      onOpen: (id, opts) => props.onOpenNote(id, opts),
      onBroken: ({ el, rect }) => {
        const id = el.getAttribute("data-note-id");
        const s = id ? getMentionStatus(id) : undefined;
        // Defensive: only "trashed" / "missing" should reach here, but the
        // attribute is set asynchronously (loading -> resolved), so it's
        // possible to click during the resolution window. Bail if the live
        // status disagrees.
        if (s !== "trashed" && s !== "missing") return;
        setBrokenMention({ el, rect, status: s });
      },
    });

    const cleanupStatus = registerMentionStatusDecorator(handles.editor, containerRef);

    const cleanupMentions = registerMentionPlugin(handles.editor, {
      onOpen: (m) => setActiveMatch(m),
      onUpdate: (m) => setActiveMatch(m),
      onClose: () => setActiveMatch(null),
      isOpen: () => activeMatch() !== null,
      navigate: (dir) => navigateFn?.(dir),
      confirmSelection: () => confirmFn?.() ?? false,
    });

    // Lazy snapshot: bind the editor handle once, the host calls it on demand.
    const snapshot = async (): Promise<EditorSnapshot | null> => {
      const ed = editorRef;
      if (!ed) return null;
      const stateObj = getEditorStateSnapshot(ed);
      const text = getPlainText(ed);
      const mentionTargetIds = collectMentionTargets(ed);
      const assetIds = collectAssetIds(ed);
      const contentJson = await stringifyEditorState(stateObj);
      return { contentJson, contentText: text, mentionTargetIds, assetIds };
    };

    const cleanupChange = handles.editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves, editorState }) => {
        // Cheap: track empty state for the placeholder, no stringify here.
        editorState.read(() => {
          const root = $getRoot();
          const size = root.getChildrenSize();
          if (size === 0) {
            setIsEmpty(true);
          } else if (size === 1) {
            const first = root.getFirstChild();
            if (first && $isParagraphNode(first) && first.getTextContentSize() === 0) {
              setIsEmpty(true);
            } else {
              setIsEmpty(false);
            }
          } else {
            setIsEmpty(false);
          }
        });

        // Track latest caret position for per-note cursor memory. Skipped during
        // state-load (`suppressChange`) so we don't capture the loaded state's
        // default selection right after switching.
        if (!suppressChange) {
          const captured = captureSelection(handles.editor);
          if (captured) {
            liveSelection = captured;
            schedulePersist();
          }
        }

        if (suppressChange) return;
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
        // Recovery mode: do NOT propagate dirty events. The save pipeline is
        // already gated by `onRecoveryChange`, but belt-and-braces here means
        // a stray transaction (selection-only formatting toggle, etc.) can't
        // sneak through and mark the note dirty against blank state.
        if (recovering()) return;

        // Don't compute the snapshot here - pass the deferred provider to the host.
        // The save pipeline debounces and pulls the snapshot once per save burst.
        props.onChange({ snapshot });
      },
    );

    onCleanup(() => {
      // Flush any pending cursor persist before tearing down - best-effort,
      // since IPC during shutdown isn't guaranteed to land.
      if (persistTimer != null) {
        clearTimeout(persistTimer);
        flushPersist();
      }
      cleanupChange();
      cleanupMentions();
      cleanupStatus();
      cleanupClick();
      props.onReady?.(null);
      handles.destroy();
    });
  });

  /** Save the editor's current caret position to in-session memory + the
   *  cursors table for the given note id. Synchronous from the user's
   *  perspective (best-effort IPC), no debounce - used on switches/external
   *  updates where a debounced write would lose the position before the
   *  state replacement runs. */
  const persistOutgoingCursor = (outgoingId: string) => {
    if (!liveSelection) return;
    selectionsByNote.set(outgoingId, liveSelection);
    if (persistTimer != null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const outgoingSel = liveSelection;
    void api
      .setCursor(outgoingId, JSON.stringify(outgoingSel))
      .catch((e) => console.warn("failed to persist cursor", e));
  };

  createEffect(() => {
    const id = props.noteId;
    if (!editorRef) return;
    if (id === lastNoteId) return;

    // Save the outgoing note's caret position before we wipe state. Cancel
    // any pending debounced persist for the outgoing note and write
    // synchronously instead so a fast switch doesn't lose the position.
    if (lastNoteId !== null) {
      persistOutgoingCursor(lastNoteId);
    }
    lastNoteId = id;
    liveSelection = null;
    // The broken-mention popover is anchored to a DOM element that's about
    // to be torn down when we load the new note's editor state. Drop it.
    setBrokenMention(null);

    suppressChange = true;
    if (props.initialJson && props.initialJson !== "{}") {
      const result = loadEditorStateFromJSON(editorRef, props.initialJson);
      if (!result.ok && result.reason === "parse_error") {
        // Don't blank-load the editor. Surface a sticky toast and flip the
        // recovery flag so the host's save pipeline freezes - we will NOT
        // overwrite the on-disk content_json with whatever blank state
        // Lexical happens to have. The user can choose to restore from a
        // snapshot or to manually clear and start over (latter is intentionally
        // not exposed automatically - it's destructive and the user must opt in).
        setRecovering(true);
        props.onRecoveryChange?.(true);
        toast.error(
          "This note's content didn't parse - editor is in recovery mode. Open snapshot history to restore.",
        );
      } else {
        if (recovering()) {
          setRecovering(false);
          props.onRecoveryChange?.(false);
        }
      }
    } else {
      if (recovering()) {
        setRecovering(false);
        props.onRecoveryChange?.(false);
      }
      editorRef.update(() => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
      });
    }

    const cachedSel = selectionsByNote.get(id) ?? null;
    queueMicrotask(() => {
      suppressChange = false;
      if (cachedSel && editorRef) {
        restoreSelection(editorRef, cachedSel);
      }
      containerRef?.focus();
      editorRef?.focus();
    });

    // Cache miss → first time we see this note this session. Fetch the
    // persisted cursor from the settings table; if the user is still on this
    // note when it returns, restore it. The race against rapid switches is
    // guarded by the `lastNoteId !== id` check.
    if (!cachedSel) {
      void api
        .getCursor(id)
        .then((raw) => {
          if (lastNoteId !== id || !raw || !editorRef) return;
          // The user might have moved the caret already since the load (e.g.
          // by clicking inside the editor) - don't stomp on a fresh selection.
          if (liveSelection) return;
          let parsed: SerializedSelection | null = null;
          try {
            parsed = JSON.parse(raw) as SerializedSelection;
          } catch (e) {
            console.warn("failed to parse persisted cursor", e);
            return;
          }
          selectionsByNote.set(id, parsed);
          restoreSelection(editorRef, parsed);
        })
        .catch((e) => console.warn("failed to read persisted cursor", e));
    }
  });

  const handleSelect = (noteId: string, title: string) => {
    const m = activeMatch();
    if (!m || !editorRef) return;
    insertMention(editorRef, m, noteId, title);
    setActiveMatch(null);
  };

  return (
    <div class="nz-editor-shell">
      <Show when={recovering()}>
        <div class="nz-editor-recovery" role="alert">
          <strong>Recovery mode.</strong> This note's content couldn't be parsed. Editing is
          disabled until you restore a snapshot - your saved content is untouched on disk.
        </div>
      </Show>
      <Show when={isEmpty() && !recovering()}>
        <div class="nz-editor-placeholder" aria-hidden="true">
          Title
        </div>
      </Show>
      <div
        ref={(el) => (containerRef = el)}
        class="nz-editor-content"
        classList={{ "nz-editor-content--recovery": recovering() }}
        contentEditable={!recovering()}
        spellcheck={!recovering()}
      />
      <Show when={activeMatch()}>
        {(match) => (
          <MentionPopover
            match={match()}
            currentNoteId={props.noteId}
            onSelect={handleSelect}
            onClose={() => setActiveMatch(null)}
            registerNavigate={(fn) => (navigateFn = fn)}
            registerConfirm={(fn) => (confirmFn = fn)}
          />
        )}
      </Show>
      <Show when={brokenMention()}>
        {(bm) => (
          <BrokenMentionPopover
            status={bm().status}
            rect={bm().rect}
            onClose={() => setBrokenMention(null)}
            onRemove={() => {
              const ed = editorRef;
              if (ed) removeMentionByDOM(ed, bm().el);
            }}
            onConvert={() => {
              const ed = editorRef;
              if (ed) convertMentionToTextByDOM(ed, bm().el);
            }}
          />
        )}
      </Show>
    </div>
  );
};
