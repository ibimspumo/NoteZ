// Single source of truth for marketing-site copy that has to track the
// desktop app. The desktop version is read from `apps/desktop/package.json`
// at build time so a desktop bump never requires touching the web files.

import desktopPkg from "../../../desktop/package.json";

export const DESKTOP_VERSION = desktopPkg.version as string;

export const DOWNLOAD_URL = "https://github.com/ibimspumo/NoteZ/releases/latest";
export const SOURCE_URL = "https://github.com/ibimspumo/NoteZ";
export const README_URL = "https://github.com/ibimspumo/NoteZ/blob/main/README.md";
export const LICENSE_URL = "https://github.com/ibimspumo/NoteZ/blob/main/LICENSE";
