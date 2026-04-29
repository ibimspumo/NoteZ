import type { Component, JSX } from "solid-js";

/**
 * Shared SVG icons. Inline because tree-shaking removes unused ones at build
 * time and the renderer doesn't pay for an external sprite sheet.
 *
 * Pattern: every icon is a `Component<IconProps>` so call sites can pass
 * `class`, `style`, `aria-hidden` etc. Defaults: `width=16 height=16`,
 * `aria-hidden="true"` (icons are decorative; add `aria-label` on the parent
 * `<button>` for accessibility).
 *
 * Why `body` is a function and not a JSX value: in Solid, JSX expressions
 * evaluate to *real DOM nodes immediately*. If we captured the body as a
 * value, every render of the same icon would reuse the same DOM nodes - and
 * since a DOM node can only live at one place at a time, mounting the icon
 * a second time would silently steal the nodes from the first mount. That's
 * the "icon disappears after I open a dialog that uses the same icon" bug.
 * Wrapping the body in `() => <>...</>` forces fresh DOM nodes per render
 * site and per remount.
 */

export type IconProps = JSX.IntrinsicElements["svg"];

const DEFAULTS: IconProps = {
  width: 16,
  height: 16,
  fill: "none",
  "aria-hidden": "true",
  xmlns: "http://www.w3.org/2000/svg",
};

const wrap =
  (body: () => JSX.Element, viewBox: string): Component<IconProps> =>
  (props) => (
    <svg {...DEFAULTS} viewBox={viewBox} {...props}>
      {body()}
    </svg>
  );

export const SearchIcon = wrap(
  () => (
    <>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" />
      <path d="M11 11L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </>
  ),
  "0 0 16 16",
);

export const TrashIcon = wrap(
  () => (
    <>
      <path
        d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.6 8.5A1.5 1.5 0 0 0 6.1 14.5h3.8a1.5 1.5 0 0 0 1.5-1.5l.6-8.5"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M7 7v5M9 7v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </>
  ),
  "0 0 16 16",
);

export const SettingsGearIcon = wrap(
  () => (
    <>
      <path
        d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.03 7.03 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.58-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.6" />
    </>
  ),
  "0 0 24 24",
);

export const NewNoteIcon = wrap(
  () => (
    <>
      <path
        d="M3 3.5C3 2.67 3.67 2 4.5 2H9L13 6V12.5C13 13.33 12.33 14 11.5 14H4.5C3.67 14 3 13.33 3 12.5V3.5Z"
        stroke="currentColor"
        stroke-width="1.3"
      />
      <path d="M9 2V6H13" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
      <path
        d="M8 8.5V11.5M6.5 10H9.5"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    </>
  ),
  "0 0 16 16",
);

export const SidebarIcon = wrap(
  () => (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.3" />
      <line x1="6.5" y1="3" x2="6.5" y2="13" stroke="currentColor" stroke-width="1.3" />
    </>
  ),
  "0 0 16 16",
);

export const PinIcon = wrap(
  () => (
    <path d="M5.5 1L7 3.5V5.5L8.5 7H6.25L5.5 10L4.75 7H2.5L4 5.5V3.5L5.5 1Z" fill="currentColor" />
  ),
  "0 0 11 11",
);

export const CloseIcon = wrap(
  () => (
    <path
      d="m3.5 3.5 7 7M10.5 3.5l-7 7"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
    />
  ),
  "0 0 14 14",
);

export const ChevronDownIcon = wrap(
  () => (
    <path
      d="M2 4l3 3 3-3"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  ),
  "0 0 10 10",
);

export const HistoryIcon = wrap(
  () => (
    <>
      <path
        d="M3.5 8a4.5 4.5 0 1 0 1.32-3.18"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        fill="none"
      />
      <path
        d="M2 3v3h3"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
      <path
        d="M8 5.5v3l2 1.5"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
    </>
  ),
  "0 0 16 16",
);

export const ExternalLinkIcon = wrap(
  () => (
    <path
      d="M4 2H9V7M9 2 3 8"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  ),
  "0 0 11 11",
);

export const ArrowLeftIcon = wrap(
  () => (
    <path
      d="M9 4 5 8l4 4M5 8h7"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  ),
  "0 0 16 16",
);
