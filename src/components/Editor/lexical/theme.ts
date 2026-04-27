import type { EditorThemeClasses } from "lexical";

export const editorTheme: EditorThemeClasses = {
  paragraph: "nz-paragraph",
  heading: {
    h1: "nz-h1",
    h2: "nz-h2",
    h3: "nz-h3",
  },
  list: {
    ul: "nz-ul",
    ol: "nz-ol",
    listitem: "nz-li",
    listitemChecked: "nz-li-checked",
    listitemUnchecked: "nz-li-unchecked",
    nested: {
      listitem: "nz-li-nested",
    },
  },
  quote: "nz-quote",
  text: {
    bold: "nz-bold",
    italic: "nz-italic",
    underline: "nz-underline",
    strikethrough: "nz-strikethrough",
    underlineStrikethrough: "nz-underline-strikethrough",
    code: "nz-code-inline",
  },
  link: "nz-link",
};
