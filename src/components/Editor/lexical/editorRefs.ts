/**
 * Live tracking of mention-target IDs and image asset IDs in the editor.
 *
 * The save pipeline needs to know two things on every save:
 *   - Which other notes does this note mention? (`mention_target_ids`)
 *   - Which assets does it reference? (`asset_ids`)
 *
 * The naive approach is "iterate every node in the editor on save". With
 * `editor.getEditorState()._nodeMap.values()` that's O(N) on the whole tree
 * for a single save - and `_nodeMap` is a private API that may break across
 * Lexical versions.
 *
 * Instead, we register a mutation listener on each custom node type
 * (`MentionNode`, `ImageNode`) at editor creation time. Lexical fires the
 * listener with `created` / `updated` / `destroyed` for the keys that
 * changed in each transaction; we maintain `Set<noteId>` and `Set<assetId>`
 * incrementally. `collectMentionTargets()` / `collectAssetIds()` become
 * O(refs) plain set reads.
 *
 * The maps live keyed by editor instance because each Lexical editor (we
 * create one per Editor mount) has its own node graph. A WeakMap keeps the
 * tracker GC'd when the editor goes away.
 */

import {
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from "lexical";
import { ImageNode } from "./imageNode";
import { MentionNode } from "./mentionNode";

type Tracker = {
  mentions: Map<NodeKey, string>; // key → noteId
  assets: Map<NodeKey, string>; // key → assetId
};

const trackers = new WeakMap<LexicalEditor, Tracker>();

/**
 * Register mutation listeners for the custom node types and seed the tracker
 * from the current editor state. Returns a cleanup that removes the listeners.
 *
 * Call this once per editor instance, right after `createEditor` and the
 * initial `setRootElement`.
 *
 * Public-API only: we walk the tree from the root via `$getRoot()` +
 * recursive descent, not the private `editorState._nodeMap`.
 */
export function registerEditorRefs(editor: LexicalEditor): () => void {
  const t: Tracker = {
    mentions: new Map(),
    assets: new Map(),
  };
  trackers.set(editor, t);

  // Seed: walk the current state once. Mutation listeners only fire for
  // nodes mutated AFTER registration, so existing nodes (e.g. when an
  // editor state is loaded from JSON before this runs) need an explicit
  // initial pass. O(n) but only at editor creation.
  editor.getEditorState().read(() => {
    const visit = (node: LexicalNode) => {
      if (node instanceof MentionNode) {
        t.mentions.set(node.getKey(), node.getNoteId());
      } else if (node instanceof ImageNode) {
        t.assets.set(node.getKey(), node.getAssetId());
      }
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) visit(child);
      }
    };
    visit($getRoot());
  });

  const offMention = editor.registerMutationListener(MentionNode, (mutated) => {
    for (const [key, kind] of mutated) {
      if (kind === "destroyed") {
        t.mentions.delete(key);
        continue;
      }
      // created or updated: read the current id from the node.
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(key);
        if (node instanceof MentionNode) {
          t.mentions.set(key, node.getNoteId());
        }
      });
    }
  });

  const offImage = editor.registerMutationListener(ImageNode, (mutated) => {
    for (const [key, kind] of mutated) {
      if (kind === "destroyed") {
        t.assets.delete(key);
        continue;
      }
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(key);
        if (node instanceof ImageNode) {
          t.assets.set(key, node.getAssetId());
        }
      });
    }
  });

  return () => {
    offMention();
    offImage();
    trackers.delete(editor);
  };
}

/** Distinct note IDs currently mentioned in this editor. */
export function collectMentionTargets(editor: LexicalEditor): string[] {
  const t = trackers.get(editor);
  if (!t) return [];
  // Distinct: a note can be mentioned more than once, but the backend stores
  // uniqueness per (source, target) tuple - we don't need duplicates.
  return Array.from(new Set(t.mentions.values()));
}

/** Distinct asset IDs currently referenced by this editor. */
export function collectAssetIds(editor: LexicalEditor): string[] {
  const t = trackers.get(editor);
  if (!t) return [];
  return Array.from(new Set(t.assets.values()));
}
