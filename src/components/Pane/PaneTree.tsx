import { type Component, For, Match, Show, Switch } from "solid-js";
import { type LayoutNode, type LeafPane, type SplitNode, totalPaneCount } from "../../stores/panes";
import { EditorPane } from "./EditorPane";
import { PaneSplitter } from "./PaneSplitter";

type CommonProps = {
  showHeader: boolean;
  onOpenNote: (id: string, opts?: { split: boolean }) => void;
  onCreate: () => Promise<void>;
};

type TreeProps = CommonProps & {
  node: LayoutNode;
};

/**
 * Recursive renderer for the layout tree, written as proper Solid components
 * so that swapping a pane for a split (or vice versa) flows through the
 * reactive system. An earlier implementation used a plain recursive function
 * which captured the tree shape at first render and didn't update when a pane
 * was split open from underneath.
 *
 * Each split becomes a flex container (row/column). Children get a wrapper
 * cell whose `flex` carries the size fraction, with a `PaneSplitter`
 * interleaved between siblings.
 */
export const PaneTree: Component<{
  node: LayoutNode;
  onOpenNote: (id: string, opts?: { split: boolean }) => void;
  onCreate: () => Promise<void>;
}> = (props) => {
  // Pane chrome (title row + close) shows only when more than one pane exists,
  // so the single-pane layout looks identical to the pre-split version.
  const showHeader = () => totalPaneCount() > 1;
  return (
    <NodeView
      node={props.node}
      showHeader={showHeader()}
      onOpenNote={props.onOpenNote}
      onCreate={props.onCreate}
    />
  );
};

const NodeView: Component<TreeProps> = (props) => (
  <Switch>
    <Match when={props.node.kind === "pane"}>
      <PaneLeaf
        node={props.node as LeafPane}
        showHeader={props.showHeader}
        onOpenNote={props.onOpenNote}
        onCreate={props.onCreate}
      />
    </Match>
    <Match when={props.node.kind === "split"}>
      <SplitView
        node={props.node as SplitNode}
        showHeader={props.showHeader}
        onOpenNote={props.onOpenNote}
        onCreate={props.onCreate}
      />
    </Match>
  </Switch>
);

const PaneLeaf: Component<CommonProps & { node: LeafPane }> = (props) => (
  <EditorPane
    paneId={props.node.id}
    noteId={props.node.noteId}
    showHeader={props.showHeader}
    onOpenNote={props.onOpenNote}
    onCreate={props.onCreate}
  />
);

const SplitView: Component<CommonProps & { node: SplitNode }> = (props) => (
  <div
    class="nz-split"
    classList={{
      row: props.node.direction === "row",
      column: props.node.direction === "column",
    }}
  >
    <For each={props.node.children}>
      {(child, i) => (
        <>
          <div class="nz-split-cell" style={{ flex: `${props.node.sizes[i()]} 1 0%` }}>
            <NodeView
              node={child}
              showHeader={props.showHeader}
              onOpenNote={props.onOpenNote}
              onCreate={props.onCreate}
            />
          </div>
          <Show when={i() < props.node.children.length - 1}>
            <PaneSplitter
              splitId={props.node.id}
              boundaryIdx={i()}
              direction={props.node.direction}
            />
          </Show>
        </>
      )}
    </For>
  </div>
);
