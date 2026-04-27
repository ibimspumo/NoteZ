import { createMemo, type Component } from "solid-js";
import { MainView } from "./views/MainView";
import { CaptureView } from "./views/CaptureView";
import { initAssetsDir } from "./components/Editor/lexical/imageNode";

// Resolve the on-disk assets directory once and cache it. Image nodes use this
// to construct file URLs synchronously during render — no per-image IPC.
void initAssetsDir().catch((e) => {
  console.warn("[App] initAssetsDir failed:", e);
});

export const App: Component = () => {
  const mode = createMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("window") === "capture" ? "capture" : "main";
  });

  return (
    <>{mode() === "capture" ? <CaptureView /> : <MainView />}</>
  );
};

export default App;
