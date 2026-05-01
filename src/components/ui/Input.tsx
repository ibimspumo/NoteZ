import { type Component, type JSX, splitProps } from "solid-js";

export type InputSize = "sm" | "md";

type Props = JSX.InputHTMLAttributes<HTMLInputElement> & {
  /** `sm` for compact dialog rows, `md` for primary forms. */
  size?: InputSize;
  /** Use monospace font - keys, paths, IDs. */
  mono?: boolean;
};

/**
 * Single-line text input. Replaces ad-hoc input styling across
 * settings, dev panel, and pickers. For multi-line text, copy
 * this primitive and swap `<input>` for `<textarea>` rather than
 * trying to overload one component.
 */
export const Input: Component<Props> = (props) => {
  const [local, rest] = splitProps(props, ["size", "mono", "class", "type"]);

  const size = (): InputSize => local.size ?? "md";

  const cls = () => {
    const parts = ["nz-input", `nz-input--${size()}`];
    if (local.mono) parts.push("nz-input--mono");
    if (local.class) parts.push(local.class);
    return parts.join(" ");
  };

  return <input {...rest} type={local.type ?? "text"} class={cls()} />;
};
