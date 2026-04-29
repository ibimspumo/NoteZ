import { type Component, createMemo } from "solid-js";
import { initAssetsDir } from "./components/Editor/lexical/imageNode";
import { ToastHost } from "./components/ToastHost";
import { loadSettings, registerSettingsBridge } from "./stores/settings";
import { CaptureView } from "./views/CaptureView";
import { MainView } from "./views/MainView";

// Resolve the on-disk assets directory once and cache it. Image nodes use this
// to construct file URLs synchronously during render - no per-image IPC.
void initAssetsDir().catch((e) => {
  console.warn("[App] initAssetsDir failed:", e);
});

// Apply color-mode class as early as possible so both windows (main + capture)
// follow the user's pick on launch. Fire-and-forget - UI does not block on it.
void loadSettings().catch((e) => {
  console.warn("[App] loadSettings failed:", e);
});

// Listen for cross-window settings change events. Both main and capture
// windows mount this so a setting change in either is reflected in the
// other's reactive state without each one needing to poll.
void registerSettingsBridge().catch((e) => {
  console.warn("[App] registerSettingsBridge failed:", e);
});

export const App: Component = () => {
  const mode = createMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("window") === "capture" ? "capture" : "main";
  });

  return (
    <>
      {mode() === "capture" ? <CaptureView /> : <MainView />}
      <ToastHost />
    </>
  );
};

export default App;
