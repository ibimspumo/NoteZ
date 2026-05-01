// Theme token contract. Single source of truth for what is themable.
// Built-in themes and user-imported `.nzt` files must define values for every
// token here; unknown tokens are rejected by the validator.
//
// Non-themable design tokens (spacing scale, type scale, radii, animation
// durations, font stacks) live in `src/styles/theme.css` under :root and are
// NOT in this contract by design - exposing them would let custom themes
// break component layout assumptions across the app.

export type TokenKind = "color" | "shadow";

export interface TokenSpec {
  /** CSS custom-property name without the leading `--`. */
  name: string;
  /** What this token represents - shown in the editor UI later. */
  label: string;
  /** Validator hint. `color` covers any CSS color (named, hex, rgb, rgba, hsl).
   * `shadow` accepts a CSS box-shadow string (one or more layers). */
  kind: TokenKind;
  /** Group used to organize the editor form. Free-form string for now. */
  group:
    | "accent"
    | "brand"
    | "danger"
    | "surface"
    | "divider"
    | "text"
    | "selection"
    | "shadow"
    | "scrollbar"
    | "highlight"
    | "mention"
    | "focus"
    | "checkbox"
    | "diff"
    | "body";
}

export const THEME_TOKENS: TokenSpec[] = [
  // Accent
  { name: "nz-accent", label: "Accent", kind: "color", group: "accent" },
  { name: "nz-accent-hot", label: "Accent (hot)", kind: "color", group: "accent" },
  { name: "nz-on-accent", label: "On accent", kind: "color", group: "accent" },
  { name: "nz-accent-soft", label: "Accent (soft)", kind: "color", group: "accent" },
  { name: "nz-accent-glow", label: "Accent (glow)", kind: "color", group: "accent" },

  // Brand mark dots in the logo
  { name: "nz-brand-bright", label: "Brand bright", kind: "color", group: "brand" },
  { name: "nz-brand-deep", label: "Brand deep", kind: "color", group: "brand" },
  { name: "nz-brand-glow", label: "Brand glow", kind: "color", group: "brand" },

  // Danger
  { name: "nz-danger", label: "Danger", kind: "color", group: "danger" },

  // Surfaces
  { name: "nz-body-bg", label: "Body background", kind: "color", group: "body" },
  { name: "nz-bg-app", label: "App background", kind: "color", group: "surface" },
  { name: "nz-bg-card", label: "Card surface", kind: "color", group: "surface" },
  { name: "nz-bg-elev", label: "Elevated surface", kind: "color", group: "surface" },
  { name: "nz-bg-overlay", label: "Overlay", kind: "color", group: "surface" },
  { name: "nz-bg-hover", label: "Hover", kind: "color", group: "surface" },
  { name: "nz-bg-active", label: "Active", kind: "color", group: "surface" },
  { name: "nz-bg-active-strong", label: "Active (strong)", kind: "color", group: "surface" },
  { name: "nz-bg-row", label: "Row tint", kind: "color", group: "surface" },

  // Dividers
  { name: "nz-divider", label: "Divider", kind: "color", group: "divider" },
  { name: "nz-divider-strong", label: "Divider (strong)", kind: "color", group: "divider" },

  // Text
  { name: "nz-text", label: "Text", kind: "color", group: "text" },
  { name: "nz-text-strong", label: "Text (strong)", kind: "color", group: "text" },
  { name: "nz-text-muted", label: "Text (muted)", kind: "color", group: "text" },
  { name: "nz-text-faint", label: "Text (faint)", kind: "color", group: "text" },
  { name: "nz-text-whisper", label: "Text (whisper)", kind: "color", group: "text" },

  // Selection
  { name: "nz-selection", label: "Text selection", kind: "color", group: "selection" },

  // Shadows
  { name: "nz-shadow-sm", label: "Shadow small", kind: "shadow", group: "shadow" },
  { name: "nz-shadow", label: "Shadow", kind: "shadow", group: "shadow" },
  { name: "nz-shadow-lg", label: "Shadow large", kind: "shadow", group: "shadow" },

  // Scrollbar
  { name: "nz-scrollbar", label: "Scrollbar", kind: "color", group: "scrollbar" },
  { name: "nz-scrollbar-hover", label: "Scrollbar (hover)", kind: "color", group: "scrollbar" },

  // Highlight (mark element, search hits)
  { name: "nz-mark", label: "Highlight", kind: "color", group: "highlight" },

  // Mention pill
  { name: "nz-mention-text", label: "Mention text", kind: "color", group: "mention" },
  { name: "nz-mention-bg", label: "Mention background", kind: "color", group: "mention" },
  { name: "nz-mention-border", label: "Mention border", kind: "color", group: "mention" },
  { name: "nz-mention-bg-hover", label: "Mention hover", kind: "color", group: "mention" },

  // Focus ring
  { name: "nz-focus-ring", label: "Focus ring", kind: "color", group: "focus" },

  // Checkbox
  { name: "nz-checkbox-fill", label: "Checkbox fill", kind: "color", group: "checkbox" },

  // Diff (semantic - red/green stay red/green even in mono).
  { name: "nz-diff-add-bg", label: "Diff added line", kind: "color", group: "diff" },
  { name: "nz-diff-add-border", label: "Diff added border", kind: "color", group: "diff" },
  { name: "nz-diff-remove-bg", label: "Diff removed line", kind: "color", group: "diff" },
  { name: "nz-diff-remove-border", label: "Diff removed border", kind: "color", group: "diff" },
  { name: "nz-diff-add-bg-strong", label: "Diff added word", kind: "color", group: "diff" },
  { name: "nz-diff-add-fg-strong", label: "Diff added word text", kind: "color", group: "diff" },
  { name: "nz-diff-remove-bg-strong", label: "Diff removed word", kind: "color", group: "diff" },
  {
    name: "nz-diff-remove-fg-strong",
    label: "Diff removed word text",
    kind: "color",
    group: "diff",
  },
];

export const TOKEN_NAMES: ReadonlySet<string> = new Set(THEME_TOKENS.map((t) => t.name));

export interface ThemeFile {
  /** Stable id. For built-ins this is "default", "light", "mono". For custom
   * themes this is a UUID generated at save time. */
  id: string;
  /** Display name. */
  name: string;
  /** Optional. Empty string means unspecified. */
  author?: string;
  /** Optional, free-form. */
  description?: string;
  /** Schema version. Bump on breaking contract changes. */
  schema: 1;
  /** Hint for OS-level integration (vibrancy material picking). Doesn't
   * affect token resolution; the active theme is what it is. */
  mode: "dark" | "light";
  /** Map of token name (without `--`) to CSS value string. */
  tokens: Record<string, string>;
}

export interface BuiltinTheme extends ThemeFile {
  builtin: true;
}
