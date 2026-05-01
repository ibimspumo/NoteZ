import { type Component, type JSX, splitProps } from "solid-js";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";
export type ButtonShape = "rect" | "pill";

type Props = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Visual weight. `secondary` is the default neutral action. */
  variant?: ButtonVariant;
  /** `sm` for dense surfaces, `md` for primary surfaces. */
  size?: ButtonSize;
  /** `pill` for in-flow CTAs (dialogs), `rect` for tool surfaces. */
  shape?: ButtonShape;
};

/**
 * Canonical actionable button. Pass `variant`, `size`, and `shape`
 * instead of composing CSS modifier classes by hand.
 */
export const Button: Component<Props> = (props) => {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "shape",
    "class",
    "type",
    "children",
  ]);

  const variant = (): ButtonVariant => local.variant ?? "secondary";
  const size = (): ButtonSize => local.size ?? "md";
  const shape = (): ButtonShape => local.shape ?? "rect";

  const cls = () => {
    const parts = ["nz-btn", `nz-btn--${variant()}`, `nz-btn--${size()}`, `nz-btn--${shape()}`];
    if (local.class) parts.push(local.class);
    return parts.join(" ");
  };

  return (
    <button {...rest} type={local.type ?? "button"} class={cls()}>
      {local.children}
    </button>
  );
};
