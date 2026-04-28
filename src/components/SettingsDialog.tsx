import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import {
  colorMode,
  commandBarShortcut,
  eventToAccelerator,
  formatAccelerator,
  quickCaptureShortcut,
  setColorMode,
  setCommandBarShortcut,
  setQuickCaptureShortcut,
  setTrashRetentionDays,
  trashRetentionDays,
  type ColorMode,
} from "../stores/settings";

type Props = {
  open: boolean;
  onClose: () => void;
};

const RETENTION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Never" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "6 months" },
  { value: 365, label: "1 year" },
];

const DEFAULT_QUICK_CAPTURE = "super+alt+KeyN";
const DEFAULT_COMMAND_BAR = "super+KeyK";

export const SettingsDialog: Component<Props> = (props) => {
  createEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={props.open}>
      <div class="nz-settings-backdrop" onClick={props.onClose}>
        <div
          class="nz-settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nz-settings-title"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            class="nz-settings-close"
            aria-label="Close"
            title="Close · esc"
            onClick={props.onClose}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="m3.5 3.5 7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>

          <h2 class="nz-settings-title" id="nz-settings-title">Settings</h2>

          <TrashRetentionSection />
          <div class="nz-settings-divider" />

          <ShortcutsSection />
          <div class="nz-settings-divider" />

          <ColorModeSection />
        </div>
      </div>
    </Show>
  );
};

const TrashRetentionSection: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const apply = async (value: number) => {
    setError(null);
    try {
      await setTrashRetentionDays(value);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section class="nz-settings-section">
      <header class="nz-settings-section-header">
        <h3>Trash retention</h3>
        <p class="nz-settings-section-hint">
          Notes in the trash are auto-deleted after this duration.
        </p>
      </header>
      <div class="nz-settings-pill-row" role="radiogroup" aria-label="Trash retention">
        {RETENTION_OPTIONS.map((opt) => (
          <button
            type="button"
            role="radio"
            aria-checked={trashRetentionDays() === opt.value}
            class="nz-settings-pill"
            classList={{ active: trashRetentionDays() === opt.value }}
            onClick={() => apply(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <Show when={error()}>
        <p class="nz-settings-error">{error()}</p>
      </Show>
    </section>
  );
};

const ShortcutsSection: Component = () => {
  return (
    <section class="nz-settings-section">
      <header class="nz-settings-section-header">
        <h3>Global shortcuts</h3>
        <p class="nz-settings-section-hint">
          Click a shortcut to record a new combination. Must include at least one modifier (⌘, ⌥, ⇧ or ⌃).
        </p>
      </header>
      <div class="nz-settings-shortcut-list">
        <ShortcutRow
          label="Search"
          value={commandBarShortcut()}
          onChange={setCommandBarShortcut}
          defaultAccelerator={DEFAULT_COMMAND_BAR}
        />
        <ShortcutRow
          label="Quick Note"
          value={quickCaptureShortcut()}
          onChange={setQuickCaptureShortcut}
          defaultAccelerator={DEFAULT_QUICK_CAPTURE}
        />
      </div>
    </section>
  );
};

type ShortcutRowProps = {
  label: string;
  value: string;
  onChange: (accelerator: string) => Promise<string>;
  defaultAccelerator: string;
};

const ShortcutRow: Component<ShortcutRowProps> = (props) => {
  const [recording, setRecording] = createSignal(false);
  const [pendingDisplay, setPendingDisplay] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  let captureRef: HTMLButtonElement | undefined;

  const startRecording = () => {
    setError(null);
    setPendingDisplay(null);
    setRecording(true);
    queueMicrotask(() => captureRef?.focus());
  };

  const cancelRecording = () => {
    setRecording(false);
    setPendingDisplay(null);
  };

  const handleKeyDown = async (e: KeyboardEvent) => {
    if (!recording()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      cancelRecording();
      return;
    }
    const accel = eventToAccelerator(e);
    if (!accel) {
      // Modifier-only or bare key — show a hint while user keeps pressing.
      setPendingDisplay(buildHint(e));
      return;
    }
    setRecording(false);
    setPendingDisplay(null);
    try {
      await props.onChange(accel);
    } catch (err) {
      setError(String(err));
    }
  };

  const resetToDefault = async () => {
    setError(null);
    try {
      await props.onChange(props.defaultAccelerator);
    } catch (err) {
      setError(String(err));
    }
  };

  const display = () => {
    const pd = pendingDisplay();
    if (recording() && pd) return pd;
    if (recording()) return "Press keys…";
    return formatAccelerator(props.value) || "—";
  };

  return (
    <div class="nz-settings-shortcut-row">
      <span class="nz-settings-shortcut-label">{props.label}</span>
      <div class="nz-settings-shortcut-controls">
        <button
          ref={(el) => (captureRef = el)}
          type="button"
          class="nz-settings-shortcut-input"
          classList={{ recording: recording() }}
          onClick={recording() ? cancelRecording : startRecording}
          onKeyDown={handleKeyDown}
          onBlur={() => recording() && cancelRecording()}
          aria-label={`${props.label} shortcut`}
        >
          {display()}
        </button>
        <button
          type="button"
          class="nz-settings-shortcut-reset"
          title="Reset to default"
          onClick={resetToDefault}
        >
          Reset
        </button>
      </div>
      <Show when={error()}>
        <p class="nz-settings-error">{error()}</p>
      </Show>
    </div>
  );
};

function buildHint(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push("⌘");
  if (e.altKey) parts.push("⌥");
  if (e.shiftKey) parts.push("⇧");
  if (e.ctrlKey) parts.push("⌃");
  return parts.length > 0 ? parts.join("") + "…" : "Press keys…";
}

const ColorModeSection: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const apply = async (mode: ColorMode) => {
    setError(null);
    try {
      await setColorMode(mode);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section class="nz-settings-section">
      <header class="nz-settings-section-header">
        <h3>Color mode</h3>
        <p class="nz-settings-section-hint">
          Monochrome removes the green accent for an all-greyscale dark UI.
        </p>
      </header>
      <div class="nz-settings-color-row" role="radiogroup" aria-label="Color mode">
        <button
          type="button"
          role="radio"
          aria-checked={colorMode() === "default"}
          class="nz-settings-color-card"
          classList={{ active: colorMode() === "default" }}
          onClick={() => apply("default")}
        >
          <span class="nz-settings-color-swatch nz-settings-color-swatch--default" aria-hidden="true" />
          <span class="nz-settings-color-name">Standard</span>
          <span class="nz-settings-color-meta">Green accent</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={colorMode() === "mono"}
          class="nz-settings-color-card"
          classList={{ active: colorMode() === "mono" }}
          onClick={() => apply("mono")}
        >
          <span class="nz-settings-color-swatch nz-settings-color-swatch--mono" aria-hidden="true" />
          <span class="nz-settings-color-name">Monochrome</span>
          <span class="nz-settings-color-meta">Greyscale only</span>
        </button>
      </div>
      <Show when={error()}>
        <p class="nz-settings-error">{error()}</p>
      </Show>
    </section>
  );
};
