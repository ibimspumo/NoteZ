import { type Component, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { dismiss, toasts } from "../stores/toasts";

/**
 * Singleton toast renderer. Mount once near the App root - it portals into
 * `document.body` so it stays on top of any modal stacking context.
 */
export const ToastHost: Component = () => {
  return (
    <Portal>
      <div class="nz-toast-host" role="region" aria-label="Notifications" aria-live="polite">
        <For each={toasts()}>
          {(t) => (
            <div class="nz-toast" data-kind={t.kind} role={t.kind === "error" ? "alert" : "status"}>
              <span class="nz-toast-message">{t.message}</span>
              <Show when={t.action}>
                {(a) => (
                  <button
                    type="button"
                    class="nz-toast-action"
                    onClick={() => {
                      a().onPress();
                      dismiss(t.id);
                    }}
                  >
                    {a().label}
                  </button>
                )}
              </Show>
              <button
                type="button"
                class="nz-toast-close"
                aria-label="Dismiss"
                title="Dismiss"
                onClick={() => dismiss(t.id)}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="m3 3 6 6M9 3l-6 6"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
};
