import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
} from "@lexical/rich-text";
import {
  $isListNode,
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListNode,
  REMOVE_LIST_COMMAND,
} from "@lexical/list";
import { $isLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { $setBlocksType } from "@lexical/selection";
import { $getNearestNodeOfType, mergeRegister } from "@lexical/utils";

type BlockKind = "paragraph" | "h1" | "h2" | "h3" | "quote" | "ul" | "ol" | "check";

type Props = {
  editor: LexicalEditor;
};

const HEADING_LABELS: Record<BlockKind, string> = {
  paragraph: "Text",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  quote: "Quote",
  ul: "Bulleted list",
  ol: "Numbered list",
  check: "Checklist",
};

export const EditorToolbar: Component<Props> = (props) => {
  const [bold, setBold] = createSignal(false);
  const [italic, setItalic] = createSignal(false);
  const [underline, setUnderline] = createSignal(false);
  const [codeFmt, setCodeFmt] = createSignal(false);
  const [link, setLink] = createSignal(false);
  const [block, setBlock] = createSignal<BlockKind>("paragraph");
  const [menuOpen, setMenuOpen] = createSignal(false);

  let menuRef: HTMLDivElement | undefined;

  const refreshFromState = () => {
    props.editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      setBold(selection.hasFormat("bold"));
      setItalic(selection.hasFormat("italic"));
      setUnderline(selection.hasFormat("underline"));
      setCodeFmt(selection.hasFormat("code"));

      const anchorNode = selection.anchor.getNode();
      const topLevel =
        anchorNode.getKey() === "root"
          ? anchorNode
          : anchorNode.getTopLevelElementOrThrow();

      let kind: BlockKind = "paragraph";
      const list = $getNearestNodeOfType<ListNode>(anchorNode, ListNode);
      if (list && $isListNode(list)) {
        const t = list.getListType();
        kind = t === "check" ? "check" : t === "number" ? "ol" : "ul";
      } else if ($isHeadingNode(topLevel)) {
        const tag = topLevel.getTag();
        kind = tag === "h1" ? "h1" : tag === "h2" ? "h2" : "h3";
      } else if ($isQuoteNode(topLevel)) {
        kind = "quote";
      }
      setBlock(kind);

      let n: LexicalNode | null = anchorNode;
      let inLink = false;
      while (n) {
        if ($isLinkNode(n)) {
          inLink = true;
          break;
        }
        n = n.getParent();
      }
      setLink(inLink);
    });
  };

  createEffect(() => {
    const cleanup = mergeRegister(
      props.editor.registerUpdateListener(() => refreshFromState()),
      props.editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          refreshFromState();
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
    onCleanup(cleanup);
  });

  // Close the heading menu on outside click.
  createEffect(() => {
    if (!menuOpen()) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef && !menuRef.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    onCleanup(() => window.removeEventListener("mousedown", onDown));
  });

  const applyBlock = (kind: BlockKind) => {
    setMenuOpen(false);
    const ed = props.editor;
    const current = block();

    // Toggle off lists/quote when re-clicking the active one.
    if (kind === current && (kind === "ul" || kind === "ol" || kind === "check")) {
      ed.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
      return;
    }

    if (kind === "ul") {
      ed.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
      return;
    }
    if (kind === "ol") {
      ed.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
      return;
    }
    if (kind === "check") {
      ed.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
      return;
    }

    // Switching out of a list back to a block-type — drop the list first.
    if (current === "ul" || current === "ol" || current === "check") {
      ed.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    }

    ed.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      if (kind === "paragraph") {
        $setBlocksType(selection, () => $createParagraphNode());
      } else if (kind === "h1" || kind === "h2" || kind === "h3") {
        $setBlocksType(selection, () => $createHeadingNode(kind));
      } else if (kind === "quote") {
        $setBlocksType(selection, () => $createQuoteNode());
      }
    });
  };

  const fmt = (f: "bold" | "italic" | "underline" | "code") => {
    props.editor.focus();
    props.editor.dispatchCommand(FORMAT_TEXT_COMMAND, f);
  };

  const handleLink = () => {
    props.editor.focus();
    if (link()) {
      props.editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
      return;
    }
    const url = window.prompt("Enter link URL");
    if (!url) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    props.editor.dispatchCommand(TOGGLE_LINK_COMMAND, normalized);
  };

  const undo = () => props.editor.dispatchCommand(UNDO_COMMAND, undefined);
  const redo = () => props.editor.dispatchCommand(REDO_COMMAND, undefined);

  return (
    <div class="nz-toolbar" role="toolbar" aria-label="Formatting">
      <div class="nz-toolbar-group">
        <button
          class="nz-tb-btn nz-tb-icon"
          aria-label="Undo"
          title="Undo · ⌘Z"
          onMouseDown={(e) => e.preventDefault()}
          onClick={undo}
        >
          <IconUndo />
        </button>
        <button
          class="nz-tb-btn nz-tb-icon"
          aria-label="Redo"
          title="Redo · ⌘⇧Z"
          onMouseDown={(e) => e.preventDefault()}
          onClick={redo}
        >
          <IconRedo />
        </button>
      </div>

      <span class="nz-toolbar-sep" aria-hidden="true" />

      <div class="nz-toolbar-group" ref={(el) => (menuRef = el)}>
        <button
          class="nz-tb-btn nz-tb-block"
          classList={{ open: menuOpen() }}
          aria-label="Block type"
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          title="Block type"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span class="nz-tb-block-label">{HEADING_LABELS[block()]}</span>
          <IconChevron />
        </button>
        <Show when={menuOpen()}>
          <div class="nz-toolbar-menu" role="menu">
            <BlockMenuItem label="Text" hint="Body" active={block() === "paragraph"} onPick={() => applyBlock("paragraph")} />
            <BlockMenuItem label="Heading 1" hint="# " active={block() === "h1"} onPick={() => applyBlock("h1")} />
            <BlockMenuItem label="Heading 2" hint="## " active={block() === "h2"} onPick={() => applyBlock("h2")} />
            <BlockMenuItem label="Heading 3" hint="### " active={block() === "h3"} onPick={() => applyBlock("h3")} />
            <BlockMenuItem label="Quote" hint="> " active={block() === "quote"} onPick={() => applyBlock("quote")} />
          </div>
        </Show>
      </div>

      <span class="nz-toolbar-sep" aria-hidden="true" />

      <div class="nz-toolbar-group">
        <button
          class="nz-tb-btn nz-tb-icon"
          classList={{ active: block() === "ul" }}
          aria-label="Bulleted list"
          aria-pressed={block() === "ul"}
          title="Bulleted list"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyBlock("ul")}
        >
          <IconBullet />
        </button>
        <button
          class="nz-tb-btn nz-tb-icon"
          classList={{ active: block() === "ol" }}
          aria-label="Numbered list"
          aria-pressed={block() === "ol"}
          title="Numbered list"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyBlock("ol")}
        >
          <IconOrdered />
        </button>
        <button
          class="nz-tb-btn nz-tb-icon"
          classList={{ active: block() === "check" }}
          aria-label="Checklist"
          aria-pressed={block() === "check"}
          title="Checklist"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyBlock("check")}
        >
          <IconCheck />
        </button>
      </div>

      <span class="nz-toolbar-sep" aria-hidden="true" />

      <div class="nz-toolbar-group">
        <button
          class="nz-tb-btn nz-tb-icon"
          classList={{ active: bold() }}
          aria-label="Bold"
          aria-pressed={bold()}
          title="Bold · ⌘B"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => fmt("bold")}
        >
          <IconBold />
        </button>
        <button
          class="nz-tb-btn nz-tb-icon"
          classList={{ active: italic() }}
          aria-label="Italic"
          aria-pressed={italic()}
          title="Italic · ⌘I"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => fmt("italic")}
        >
          <IconItalic />
        </button>
        <button
          class="nz-tb-btn nz-tb-icon"
          classList={{ active: underline() }}
          aria-label="Underline"
          aria-pressed={underline()}
          title="Underline · ⌘U"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => fmt("underline")}
        >
          <IconUnderline />
        </button>
      </div>

      <span class="nz-toolbar-sep" aria-hidden="true" />

      <div class="nz-toolbar-group">
        <button
          class="nz-tb-btn nz-tb-icon"
          classList={{ active: link() }}
          aria-label="Link"
          aria-pressed={link()}
          title="Link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleLink}
        >
          <IconLink />
        </button>
        <button
          class="nz-tb-btn nz-tb-icon"
          classList={{ active: codeFmt() }}
          aria-label="Inline code"
          aria-pressed={codeFmt()}
          title="Inline code"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => fmt("code")}
        >
          <IconCode />
        </button>
      </div>
    </div>
  );
};

const BlockMenuItem: Component<{
  label: string;
  hint?: string;
  active: boolean;
  onPick: () => void;
}> = (props) => (
  <button
    class="nz-toolbar-menu-item"
    classList={{ active: props.active }}
    role="menuitem"
    onMouseDown={(e) => e.preventDefault()}
    onClick={props.onPick}
  >
    <span>{props.label}</span>
    <Show when={props.hint}>
      <span class="nz-toolbar-menu-hint">{props.hint}</span>
    </Show>
  </button>
);

const IconUndo: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M3.5 7.5h6.25a3 3 0 0 1 0 6H6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M5.5 5 3 7.5l2.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
const IconRedo: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M12.5 7.5H6.25a3 3 0 0 0 0 6H10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M10.5 5 13 7.5 10.5 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
const IconChevron: Component = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M2.5 4 5 6.5 7.5 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
const IconBold: Component = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M4 2.5h3.5a2.25 2.25 0 0 1 0 4.5H4V2.5Zm0 4.5h4a2.25 2.25 0 0 1 0 4.5H4V7Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
  </svg>
);
const IconItalic: Component = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M9.5 2.5h-4M8.5 11.5h-4M8.5 2.5 5.5 11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
);
const IconUnderline: Component = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M3.5 2.5v5a3.5 3.5 0 0 0 7 0v-5M3 12h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
);
const IconBullet: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="3.5" cy="4.5" r="1.1" fill="currentColor" />
    <circle cx="3.5" cy="11.5" r="1.1" fill="currentColor" />
    <line x1="6.5" y1="4.5" x2="13.5" y2="4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <line x1="6.5" y1="11.5" x2="13.5" y2="11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
);
const IconOrdered: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <text x="2" y="6" font-size="4.5" font-weight="700" fill="currentColor" font-family="-apple-system, system-ui, sans-serif">1.</text>
    <text x="2" y="13" font-size="4.5" font-weight="700" fill="currentColor" font-family="-apple-system, system-ui, sans-serif">2.</text>
    <line x1="7" y1="4.5" x2="14" y2="4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <line x1="7" y1="11.5" x2="14" y2="11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
);
const IconCheck: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="3" width="4" height="4" rx="1" stroke="currentColor" stroke-width="1.4" />
    <path d="m2.7 5 .9.9 1.7-1.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    <rect x="2" y="9.5" width="4" height="4" rx="1" stroke="currentColor" stroke-width="1.4" />
    <line x1="8" y1="5" x2="14" y2="5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <line x1="8" y1="11.5" x2="14" y2="11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
);
const IconLink: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <path d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
  </svg>
);
const IconCode: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="m6 5-3 3 3 3M10 5l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
