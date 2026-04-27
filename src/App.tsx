import { createMemo, type Component } from "solid-js";
import { MainView } from "./views/MainView";
import { CaptureView } from "./views/CaptureView";

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
