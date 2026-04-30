/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { applyTheme } from "./lib/applyTheme";
import { installExternalLinkGuard } from "./lib/externalLinks";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "./themes";
import "./styles/global.css";
import "./styles/theme.css";

// Apply the default theme synchronously before mount so the first paint has
// all themable tokens defined. The settings loader may overwrite this with
// the user's chosen theme once it resolves, but if the load fails (or is slow)
// the UI is still styled.
const fallback = BUILTIN_THEMES.find((t) => t.id === DEFAULT_THEME_ID);
if (fallback) applyTheme(fallback);
import "./styles/app.css";
import "./styles/panes.css";
import "./styles/sidebar.css";
import "./styles/editor.css";
import "./styles/command-bar.css";
import "./styles/capture.css";
import "./styles/about.css";
import "./styles/settings.css";
import "./styles/trash.css";
import "./styles/dev-panel.css";
import "./styles/toast.css";
import "./styles/snapshots.css";
import "./styles/print.css";

// Route every external link through the system browser. Without this, the
// webview's right-click "Open Link" or middle-click would navigate the
// app in place and there'd be no way back without a restart.
installExternalLinkGuard();

render(() => <App />, document.getElementById("root") as HTMLElement);
