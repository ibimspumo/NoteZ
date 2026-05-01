import { type Component, type JSX, splitProps } from "solid-js";

type Props = JSX.HTMLAttributes<HTMLElement> & {
  children: JSX.Element;
};

/**
 * Keyboard shortcut chip. Renders a `<kbd>` so assistive tech
 * announces the content as a key, not body text. Used in the
 * search trigger, capture-window hints, and any "press X to Y"
 * affordance.
 */
export const Kbd: Component<Props> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children"]);

  const cls = () => (local.class ? `nz-kbd ${local.class}` : "nz-kbd");

  return (
    <kbd {...rest} class={cls()}>
      {local.children}
    </kbd>
  );
};
