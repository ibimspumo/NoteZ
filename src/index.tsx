/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./styles/global.css";
import "./styles/theme.css";
import "./styles/app.css";
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

render(() => <App />, document.getElementById("root") as HTMLElement);
