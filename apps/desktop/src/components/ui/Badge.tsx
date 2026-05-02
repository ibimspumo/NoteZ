import { type Component, type JSX, splitProps } from "solid-js";

export type BadgeVariant = "neutral" | "accent" | "mono";

type Props = JSX.HTMLAttributes<HTMLSpanElement> & {
  /** `neutral` = grey count chip, `accent` = green status, `mono`
   *  = version / hash. */
  variant?: BadgeVariant;
};

/**
 * Static inline label - count chips, type markers, version pill.
 * Renders a `<span>`; if you need a clickable pill, use
 * `<Button shape="pill" size="sm">`.
 */
export const Badge: Component<Props> = (props) => {
  const [local, rest] = splitProps(props, ["variant", "class", "children"]);

  const variant = (): BadgeVariant => local.variant ?? "neutral";

  const cls = () => {
    const parts = ["nz-badge", `nz-badge--${variant()}`];
    if (local.class) parts.push(local.class);
    return parts.join(" ");
  };

  return (
    <span {...rest} class={cls()}>
      {local.children}
    </span>
  );
};
