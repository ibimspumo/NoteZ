import { $isLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import {
  $isListNode,
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListNode,
  REMOVE_LIST_COMMAND,
} from "@lexical/list";
import { $createHeadingNode, $isHeadingNode } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import { $findMatchingParent, $getNearestNodeOfType, mergeRegister } from "@lexical/utils";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  type LexicalEditor,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
} from "lexical";
import { type Component, createEffect, createSignal, onCleanup } from "solid-js";

type BlockKind = "paragraph" | "h1" | "h2" | "h3" | "ul" | "ol" | "check";

type Props = {
  /** Active editor, or null when there's no editor on screen (empty tab,
   *  picker visible). When null, the toolbar still renders all buttons but
   *  they're disabled - the strip stays visually present so the chrome
   *  doesn't flicker on tab/note switches. */
  editor: LexicalEditor | null;
};

export const EditorToolbar: Component<Props> = (props) => {
  const [bold, setBold] = createSignal(false);
  const [italic, setItalic] = createSignal(false);
  const [underline, setUnderline] = createSignal(false);
  const [codeFmt, setCodeFmt] = createSignal(false);
  const [link, setLink] = createSignal(false);
  const [block, setBlock] = createSignal<BlockKind>("paragraph");

  const isDisabled = () => props.editor === null;

  const refreshFromState = () => {
    const ed = props.editor;
    if (!ed) {
      // No editor → snap signals back to defaults so the buttons read
      // "inactive" rather than carrying stale state from the previous tab.
      setBold(false);
      setItalic(false);
      setUnderline(false);
      setCodeFmt(false);
      setLink(false);
      setBlock("paragraph");
      return;
    }
    ed.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      setBold(selection.hasFormat("bold"));
      setItalic(selection.hasFormat("italic"));
      setUnderline(selection.hasFormat("underline"));
      setCodeFmt(selection.hasFormat("code"));

      const anchorNode = selection.anchor.getNode();
      const topLevel =
        anchorNode.getKey() === "root" ? anchorNode : anchorNode.getTopLevelElementOrThrow();

      let kind: BlockKind = "paragraph";
      const list = $getNearestNodeOfType<ListNode>(anchorNode, ListNode);
      if (list && $isListNode(list)) {
        const t = list.getListType();
        kind = t === "check" ? "check" : t === "number" ? "ol" : "ul";
      } else if ($isHeadingNode(topLevel)) {
        const tag = topLevel.getTag();
        kind = tag === "h1" ? "h1" : tag === "h2" ? "h2" : "h3";
      }
      setBlock(kind);

      // Use $findMatchingParent (idiomatic, single helper) instead of a manual
      // parent-chain walk - same complexity, half the code.
      const linkAncestor = $findMatchingParent(anchorNode, $isLinkNode);
      setLink(linkAncestor !== null);
    });
  };

  createEffect(() => {
    const ed = props.editor;
    // Re-running on editor swap (tab switch) - the previous editor's command
    // listener is torn down via onCleanup, the new one registers fresh below.
    // When ed is null we still call refreshFromState so the signals reset.
    refreshFromState();
    if (!ed) return;
    // We deliberately do NOT subscribe to registerUpdateListener here. That
    // listener fires on every keystroke (Lexical fires it once per
    // transaction), and the toolbar state only changes when the *selection*
    // moves or when a format command runs. SELECTION_CHANGE_COMMAND covers
    // both cases (Lexical dispatches it after format toggles too) - and
    // saves us a $getEditorState().read() + tree walk per keystroke, which
    // for 100k-node notes is a measurable jank source.
    const cleanup = mergeRegister(
      ed.registerCommand(
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

  const applyBlock = (kind: BlockKind) => {
    const ed = props.editor;
    if (!ed) return;
    const current = block();

    // Toggle off lists/headings when re-clicking the active one — drops back
    // to a plain paragraph for headings, removes the list for lists.
    if (kind === current) {
      if (kind === "ul" || kind === "ol" || kind === "check") {
        ed.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
        return;
      }
      if (kind === "h1" || kind === "h2" || kind === "h3") {
        ed.update(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) return;
          $setBlocksType(sel, () => $createParagraphNode());
        });
        return;
      }
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
      }
    });
  };

  const fmt = (f: "bold" | "italic" | "underline" | "code") => {
    const ed = props.editor;
    if (!ed) return;
    ed.focus();
    ed.dispatchCommand(FORMAT_TEXT_COMMAND, f);
  };

  const handleLink = () => {
    const ed = props.editor;
    if (!ed) return;
    ed.focus();
    if (link()) {
      ed.dispatchCommand(TOGGLE_LINK_COMMAND, null);
      return;
    }
    const url = window.prompt("Enter link URL");
    if (!url) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    ed.dispatchCommand(TOGGLE_LINK_COMMAND, normalized);
  };

  const undo = () => props.editor?.dispatchCommand(UNDO_COMMAND, undefined);
  const redo = () => props.editor?.dispatchCommand(REDO_COMMAND, undefined);

  const disabled = isDisabled();

  return (
    <div
      class="nz-toolbar"
      classList={{ disabled }}
      role="toolbar"
      aria-label="Formatting"
      aria-disabled={disabled}
      data-tauri-drag-region
    >
      <div class="nz-toolbar-group" data-tauri-drag-region>
        <ToolbarBtn label="Undo" hint="Undo · ⌘Z" disabled={disabled} onPress={undo}>
          <IconUndo />
        </ToolbarBtn>
        <ToolbarBtn label="Redo" hint="Redo · ⌘⇧Z" disabled={disabled} onPress={redo}>
          <IconRedo />
        </ToolbarBtn>
      </div>

      <span class="nz-toolbar-sep" aria-hidden="true" data-tauri-drag-region />

      <div class="nz-toolbar-group" data-tauri-drag-region>
        <ToolbarBtn
          label="Body text"
          hint="Body"
          active={block() === "paragraph"}
          disabled={disabled}
          onPress={() => applyBlock("paragraph")}
        >
          <IconParagraph />
        </ToolbarBtn>
        <ToolbarBtn
          label="Heading 1"
          hint="Heading 1"
          active={block() === "h1"}
          disabled={disabled}
          onPress={() => applyBlock("h1")}
        >
          <IconH1 />
        </ToolbarBtn>
        <ToolbarBtn
          label="Heading 2"
          hint="Heading 2"
          active={block() === "h2"}
          disabled={disabled}
          onPress={() => applyBlock("h2")}
        >
          <IconH2 />
        </ToolbarBtn>
        <ToolbarBtn
          label="Heading 3"
          hint="Heading 3"
          active={block() === "h3"}
          disabled={disabled}
          onPress={() => applyBlock("h3")}
        >
          <IconH3 />
        </ToolbarBtn>
      </div>

      <span class="nz-toolbar-sep" aria-hidden="true" data-tauri-drag-region />

      <div class="nz-toolbar-group" data-tauri-drag-region>
        <ToolbarBtn
          label="Bulleted list"
          hint="Bulleted list"
          active={block() === "ul"}
          disabled={disabled}
          onPress={() => applyBlock("ul")}
        >
          <IconBullet />
        </ToolbarBtn>
        <ToolbarBtn
          label="Numbered list"
          hint="Numbered list"
          active={block() === "ol"}
          disabled={disabled}
          onPress={() => applyBlock("ol")}
        >
          <IconOrdered />
        </ToolbarBtn>
        <ToolbarBtn
          label="Checklist"
          hint="Checklist"
          active={block() === "check"}
          disabled={disabled}
          onPress={() => applyBlock("check")}
        >
          <IconCheck />
        </ToolbarBtn>
      </div>

      <span class="nz-toolbar-sep" aria-hidden="true" data-tauri-drag-region />

      <div class="nz-toolbar-group" data-tauri-drag-region>
        <ToolbarBtn
          label="Bold"
          hint="Bold · ⌘B"
          active={bold()}
          disabled={disabled}
          onPress={() => fmt("bold")}
        >
          <IconBold />
        </ToolbarBtn>
        <ToolbarBtn
          label="Italic"
          hint="Italic · ⌘I"
          active={italic()}
          disabled={disabled}
          onPress={() => fmt("italic")}
        >
          <IconItalic />
        </ToolbarBtn>
        <ToolbarBtn
          label="Underline"
          hint="Underline · ⌘U"
          active={underline()}
          disabled={disabled}
          onPress={() => fmt("underline")}
        >
          <IconUnderline />
        </ToolbarBtn>
      </div>

      <span class="nz-toolbar-sep" aria-hidden="true" data-tauri-drag-region />

      <div class="nz-toolbar-group" data-tauri-drag-region>
        <ToolbarBtn
          label="Link"
          hint="Link"
          active={link()}
          disabled={disabled}
          onPress={handleLink}
        >
          <IconLink />
        </ToolbarBtn>
        <ToolbarBtn
          label="Inline code"
          hint="Inline code"
          active={codeFmt()}
          disabled={disabled}
          onPress={() => fmt("code")}
        >
          <IconCode />
        </ToolbarBtn>
      </div>
    </div>
  );
};

const ToolbarBtn: Component<{
  label: string;
  hint?: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: import("solid-js").JSX.Element;
}> = (props) => (
  <button
    class="nz-tb-btn nz-tb-icon"
    classList={{ active: !!props.active, disabled: !!props.disabled }}
    aria-label={props.label}
    aria-pressed={props.active ? true : undefined}
    aria-disabled={props.disabled ? true : undefined}
    disabled={props.disabled}
    title={props.hint ?? props.label}
    onMouseDown={(e) => e.preventDefault()}
    onClick={props.onPress}
  >
    {props.children}
  </button>
);

const IconUndo: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M3.5 7.5h6.25a3 3 0 0 1 0 6H6"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M5.5 5 3 7.5l2.5 2.5"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);
const IconRedo: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M12.5 7.5H6.25a3 3 0 0 0 0 6H10"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M10.5 5 13 7.5 10.5 10"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);
const IconParagraph: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M3.5 4.5h9M3.5 8h9M3.5 11.5h6"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
  </svg>
);
const IconH1: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <text
      x="1.5"
      y="11"
      font-size="9"
      font-weight="800"
      fill="currentColor"
      font-family="-apple-system, system-ui, sans-serif"
      letter-spacing="-0.02em"
    >
      H
    </text>
    <text
      x="9"
      y="12.6"
      font-size="5.4"
      font-weight="700"
      fill="currentColor"
      font-family="-apple-system, system-ui, sans-serif"
    >
      1
    </text>
  </svg>
);
const IconH2: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <text
      x="2"
      y="11"
      font-size="8"
      font-weight="800"
      fill="currentColor"
      font-family="-apple-system, system-ui, sans-serif"
      letter-spacing="-0.02em"
    >
      H
    </text>
    <text
      x="9"
      y="12.6"
      font-size="5.4"
      font-weight="700"
      fill="currentColor"
      font-family="-apple-system, system-ui, sans-serif"
    >
      2
    </text>
  </svg>
);
const IconH3: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <text
      x="2.5"
      y="11"
      font-size="7"
      font-weight="800"
      fill="currentColor"
      font-family="-apple-system, system-ui, sans-serif"
      letter-spacing="-0.02em"
    >
      H
    </text>
    <text
      x="9"
      y="12.6"
      font-size="5.4"
      font-weight="700"
      fill="currentColor"
      font-family="-apple-system, system-ui, sans-serif"
    >
      3
    </text>
  </svg>
);
const IconBold: Component = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path
      d="M4 2.5h3.5a2.25 2.25 0 0 1 0 4.5H4V2.5Zm0 4.5h4a2.25 2.25 0 0 1 0 4.5H4V7Z"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linejoin="round"
    />
  </svg>
);
const IconItalic: Component = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path
      d="M9.5 2.5h-4M8.5 11.5h-4M8.5 2.5 5.5 11.5"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
  </svg>
);
const IconUnderline: Component = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path
      d="M3.5 2.5v5a3.5 3.5 0 0 0 7 0v-5M3 12h8"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
  </svg>
);
const IconBullet: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="3.5" cy="4.5" r="1.1" fill="currentColor" />
    <circle cx="3.5" cy="11.5" r="1.1" fill="currentColor" />
    <line
      x1="6.5"
      y1="4.5"
      x2="13.5"
      y2="4.5"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
    <line
      x1="6.5"
      y1="11.5"
      x2="13.5"
      y2="11.5"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
  </svg>
);
const IconOrdered: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <text
      x="2"
      y="6"
      font-size="4.5"
      font-weight="700"
      fill="currentColor"
      font-family="-apple-system, system-ui, sans-serif"
    >
      1.
    </text>
    <text
      x="2"
      y="13"
      font-size="4.5"
      font-weight="700"
      fill="currentColor"
      font-family="-apple-system, system-ui, sans-serif"
    >
      2.
    </text>
    <line
      x1="7"
      y1="4.5"
      x2="14"
      y2="4.5"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
    <line
      x1="7"
      y1="11.5"
      x2="14"
      y2="11.5"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
  </svg>
);
const IconCheck: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="3" width="4" height="4" rx="1" stroke="currentColor" stroke-width="1.4" />
    <path
      d="m2.7 5 .9.9 1.7-1.7"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <rect x="2" y="9.5" width="4" height="4" rx="1" stroke="currentColor" stroke-width="1.4" />
    <line
      x1="8"
      y1="5"
      x2="14"
      y2="5"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
    <line
      x1="8"
      y1="11.5"
      x2="14"
      y2="11.5"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
  </svg>
);
const IconLink: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
    <path
      d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
  </svg>
);
const IconCode: Component = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path
      d="m6 5-3 3 3 3M10 5l3 3-3 3"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);
