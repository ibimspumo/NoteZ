import { type Component, Show, Suspense, createMemo, lazy } from "solid-js";
import { ToastHost } from "./components/ToastHost";
import { loadSettings, registerSettingsBridge } from "./stores/settings";

// Lazy-load both views so the bundle a window first parses contains only
// what that window actually renders. The capture window in particular
// doesn't need Lexical (~150 KB after the manualChunks split in vite.config),
// so its cold start parses ~70 % less JS.
const MainView = lazy(() => import("./views/MainView").then((m) => ({ default: m.MainView })));
const CaptureView = lazy(() =>
  import("./views/CaptureView").then((m) => ({ default: m.CaptureView })),
);

// Resolve the on-disk assets directory once and cache it. Image nodes use this
// to construct file URLs synchronously during render - no per-image IPC.
// We import the module dynamically only when the main window mounts, since
// the capture window never renders an editor and never resolves an image
// path. This shaves another small chunk off the capture cold start.
void (async () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("window") === "capture") return;
  const { initAssetsDir } = await import("./components/Editor/lexical/imageNode");
  initAssetsDir().catch((e) => {
    console.warn("[App] initAssetsDir failed:", e);
  });
})();

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
      <Suspense fallback={null}>
        <Show when={mode() === "capture"} fallback={<MainView />}>
          <CaptureView />
        </Show>
      </Suspense>
      <ToastHost />
    </>
  );
};

export default App;
