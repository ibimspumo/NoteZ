import { type Component, type JSX, splitProps } from "solid-js";

export type IconButtonSize = "xs" | "sm" | "md";

type Props = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** xs (20px), sm (24px), md (28px - default). */
  size?: IconButtonSize;
  /** Allow horizontal growth so icon+label combos fit (toolbar). */
  flex?: boolean;
  /** Opt in to the `.is-active` accent state. Without this the
   *  active styling never applies, even if the prop is true. */
  toggle?: boolean;
  /** Toggleable buttons report their state here. Mirrors
   *  `aria-pressed` so screen readers see the same truth. */
  active?: boolean;
  /** Required: every icon-only control needs an accessible name. */
  "aria-label": string;
};

/**
 * Square icon button. Use `flex` + `toggle` for editor toolbar
 * buttons that hold mixed icon+text and need an active state;
 * leave both off for plain corner-of-the-dialog close buttons.
 */
export const IconButton: Component<Props> = (props) => {
  const [local, rest] = splitProps(props, [
    "size",
    "flex",
    "toggle",
    "active",
    "class",
    "type",
    "children",
  ]);

  const size = (): IconButtonSize => local.size ?? "md";

  const cls = () => {
    const parts = ["nz-iconbtn", `nz-iconbtn--${size()}`];
    if (local.flex) parts.push("nz-iconbtn--flex");
    if (local.toggle) parts.push("nz-iconbtn--toggle");
    if (local.toggle && local.active) parts.push("is-active");
    if (local.class) parts.push(local.class);
    return parts.join(" ");
  };

  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      class={cls()}
      aria-pressed={local.toggle ? local.active === true : undefined}
    >
      {local.children}
    </button>
  );
};
