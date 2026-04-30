import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { AIActivityDialog } from "../components/AIActivityDialog";
import { api } from "../lib/tauri";
import type { AiModel, AiStats } from "../lib/types";
import {
  type SidebarPreviewLines,
  aiHasKey,
  aiModel,
  aiTitleEnabled,
  autoDownloadUpdates,
  commandBarShortcut,
  eventToAccelerator,
  formatAccelerator,
  listAvailableThemes,
  quickCaptureShortcut,
  setActiveTheme,
  setAiModelChoice,
  setAiTitleEnabled,
  setAutoDownloadUpdates,
  setCommandBarShortcut,
  setOpenrouterApiKey,
  setQuickCaptureShortcut,
  setSidebarPreviewLines,
  setTrashRetentionDays,
  sidebarPreviewLines,
  themeId,
  trashRetentionDays,
} from "../stores/settings";
import { closeSettings } from "../stores/ui";

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

export const SettingsView: Component = () => {
  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="nz-settings-view" role="region" aria-labelledby="nz-settings-title">
      <header class="nz-settings-view-header" data-tauri-drag-region>
        <button
          type="button"
          class="nz-settings-view-back"
          aria-label="Close settings"
          title="Close · esc"
          onClick={closeSettings}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M8.5 3 4.5 7l4 4"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>Back</span>
        </button>
        <h1 class="nz-settings-view-title" id="nz-settings-title">
          Settings
        </h1>
      </header>

      <div class="nz-settings-view-scroll">
        <div class="nz-settings-view-inner">
          <SidebarDensitySection />
          <div class="nz-settings-divider" />

          <TrashRetentionSection />
          <div class="nz-settings-divider" />

          <ShortcutsSection />
          <div class="nz-settings-divider" />

          <AISection />
          <div class="nz-settings-divider" />

          <UpdatesSection />
          <div class="nz-settings-divider" />

          <ThemeSection />
        </div>
      </div>
    </div>
  );
};

const PREVIEW_OPTIONS: Array<{ value: SidebarPreviewLines; label: string }> = [
  { value: 0, label: "Compact" },
  { value: 1, label: "1 line" },
  { value: 2, label: "2 lines" },
];

const SidebarDensitySection: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const apply = async (value: SidebarPreviewLines) => {
    setError(null);
    try {
      await setSidebarPreviewLines(value);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section class="nz-settings-section">
      <header class="nz-settings-section-header">
        <h3>Sidebar density</h3>
        <p class="nz-settings-section-hint">
          How many preview lines to show per note in the sidebar. Compact shows just the title.
        </p>
      </header>
      <div class="nz-settings-pill-row" role="radiogroup" aria-label="Sidebar density">
        {PREVIEW_OPTIONS.map((opt) => (
          <button
            type="button"
            role="radio"
            aria-checked={sidebarPreviewLines() === opt.value}
            class="nz-settings-pill"
            classList={{ active: sidebarPreviewLines() === opt.value }}
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
          Click a shortcut to record a new combination. Must include at least one modifier (⌘, ⌥, ⇧
          or ⌃).
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
    return formatAccelerator(props.value) || "-";
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
  return parts.length > 0 ? `${parts.join("")}…` : "Press keys…";
}

const ThemeSection: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const apply = async (id: string) => {
    setError(null);
    try {
      await setActiveTheme(id);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section class="nz-settings-section">
      <header class="nz-settings-section-header">
        <h3>Theme</h3>
        <p class="nz-settings-section-hint">
          Choose the look of NoteZ. Custom themes are coming next.
        </p>
      </header>
      <div class="nz-settings-color-row" role="radiogroup" aria-label="Theme">
        <For each={listAvailableThemes()}>
          {(theme) => (
            <button
              type="button"
              role="radio"
              aria-checked={themeId() === theme.id}
              class="nz-settings-color-card"
              classList={{ active: themeId() === theme.id }}
              onClick={() => apply(theme.id)}
            >
              <span
                class="nz-settings-color-swatch"
                aria-hidden="true"
                style={{
                  background: `linear-gradient(120deg, ${theme.tokens["nz-bg-elev"]} 0% 60%, ${theme.tokens["nz-accent"]} 60% 100%)`,
                }}
              />
              <span class="nz-settings-color-name">{theme.name}</span>
              <span class="nz-settings-color-meta">
                {theme.description ?? (theme.mode === "light" ? "Light" : "Dark")}
              </span>
            </button>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p class="nz-settings-error">{error()}</p>
      </Show>
    </section>
  );
};

const UpdatesSection: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const apply = async (next: boolean) => {
    setError(null);
    try {
      await setAutoDownloadUpdates(next);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section class="nz-settings-section">
      <header class="nz-settings-section-header">
        <h3>Updates</h3>
        <p class="nz-settings-section-hint">
          NoteZ checks GitHub once an hour for new releases - that's the only background network
          call it makes. When auto-download is on, the new version is fetched and unpacked silently
          in the background; the sidebar pill flips to "Restart to apply" once it's ready, and
          quitting NoteZ at any point lands you on the new version next launch.
        </p>
      </header>
      <div class="nz-settings-pill-row" role="radiogroup" aria-label="Auto-download updates">
        <button
          type="button"
          role="radio"
          aria-checked={!autoDownloadUpdates()}
          class="nz-settings-pill"
          classList={{ active: !autoDownloadUpdates() }}
          onClick={() => void apply(false)}
        >
          Off
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={autoDownloadUpdates()}
          class="nz-settings-pill"
          classList={{ active: autoDownloadUpdates() }}
          onClick={() => void apply(true)}
        >
          On
        </button>
      </div>
      <Show when={error()}>
        <p class="nz-settings-error">{error()}</p>
      </Show>
    </section>
  );
};

const AISection: Component = () => {
  const [keyInput, setKeyInput] = createSignal("");
  const [showKey, setShowKey] = createSignal(false);
  const [savingKey, setSavingKey] = createSignal(false);
  const [stats, setStats] = createSignal<AiStats | null>(null);
  const [activityOpen, setActivityOpen] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [pickerOpen, setPickerOpen] = createSignal(false);

  const refreshStats = async () => {
    try {
      const s = await api.getAiStats();
      setStats(s);
    } catch (e) {
      console.warn("get_ai_stats failed:", e);
    }
  };

  void refreshStats();

  const onToggle = async (next: boolean) => {
    setError(null);
    try {
      await setAiTitleEnabled(next);
    } catch (e) {
      setError(String(e));
    }
  };

  const onSaveKey = async () => {
    const value = keyInput().trim();
    if (!value) return;
    setSavingKey(true);
    setError(null);
    try {
      await setOpenrouterApiKey(value);
      setKeyInput("");
      setShowKey(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingKey(false);
    }
  };

  const onClearKey = async () => {
    setError(null);
    try {
      await setOpenrouterApiKey("");
      if (aiTitleEnabled()) await setAiTitleEnabled(false);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section class="nz-settings-section">
      <header class="nz-settings-section-header">
        <h3>AI title generation</h3>
        <p class="nz-settings-section-hint">
          When you save a Quick Note, NoteZ asks an LLM via OpenRouter to write a short title in the
          note's language. Uses your own API key and credits.
        </p>
      </header>

      <div class="nz-settings-pill-row" role="radiogroup" aria-label="AI title generation">
        <button
          type="button"
          role="radio"
          aria-checked={!aiTitleEnabled()}
          class="nz-settings-pill"
          classList={{ active: !aiTitleEnabled() }}
          onClick={() => void onToggle(false)}
        >
          Off
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={aiTitleEnabled()}
          class="nz-settings-pill"
          classList={{ active: aiTitleEnabled() }}
          onClick={() => void onToggle(true)}
          disabled={!aiHasKey()}
          title={!aiHasKey() ? "Set an API key first" : undefined}
        >
          On
        </button>
      </div>

      <div class="nz-ai-key-row">
        <label class="nz-ai-key-label" for="nz-openrouter-key">
          OpenRouter API key
        </label>
        <Show
          when={!aiHasKey() || keyInput().length > 0}
          fallback={
            <div class="nz-ai-key-stored">
              <span class="nz-ai-key-mask">••••••••••••••••</span>
              <button class="nz-pill-btn danger" type="button" onClick={() => void onClearKey()}>
                Clear
              </button>
            </div>
          }
        >
          <div class="nz-ai-key-input-wrap">
            <input
              id="nz-openrouter-key"
              type={showKey() ? "text" : "password"}
              class="nz-ai-key-input"
              placeholder="sk-or-v1-..."
              autocomplete="off"
              spellcheck={false}
              value={keyInput()}
              onInput={(e) => setKeyInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onSaveKey();
                }
              }}
            />
            <button
              type="button"
              class="nz-ai-key-eye"
              onClick={() => setShowKey((s) => !s)}
              aria-label={showKey() ? "Hide key" : "Show key"}
              title={showKey() ? "Hide" : "Show"}
            >
              {showKey() ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              class="nz-pill-btn"
              onClick={() => void onSaveKey()}
              disabled={savingKey() || keyInput().trim().length === 0}
            >
              Save
            </button>
            <Show when={aiHasKey()}>
              <button
                type="button"
                class="nz-pill-btn"
                onClick={() => {
                  setKeyInput("");
                  setShowKey(false);
                }}
              >
                Cancel
              </button>
            </Show>
          </div>
        </Show>
        <p class="nz-ai-key-hint">
          Stored locally in NoteZ's database. Get one at{" "}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer noopener"
            class="nz-ai-link"
          >
            openrouter.ai/keys
          </a>
          .
        </p>
      </div>

      <div class="nz-ai-model-row">
        <span class="nz-ai-key-label">Model</span>
        <button
          type="button"
          class="nz-ai-model-button"
          onClick={() => setPickerOpen(true)}
          title="Pick a model"
        >
          <span class="nz-ai-model-id">{aiModel()}</span>
          <ChevronDown />
        </button>
      </div>

      <div class="nz-ai-activity-row">
        <Show when={stats()} fallback={<span class="nz-ai-activity-summary">Loading…</span>}>
          {(s) => (
            <span class="nz-ai-activity-summary">
              {s().total_calls} call{s().total_calls === 1 ? "" : "s"} ·{" "}
              {formatUsdCompact(s().total_cost_usd)} spent
              <Show when={s().error_calls > 0}>
                {" "}
                · <span class="nz-ai-activity-errors">{s().error_calls} failed</span>
              </Show>
            </span>
          )}
        </Show>
        <button type="button" class="nz-pill-btn" onClick={() => setActivityOpen(true)}>
          View activity
        </button>
      </div>

      <Show when={error()}>
        <p class="nz-settings-error">{error()}</p>
      </Show>

      <ModelPicker
        open={pickerOpen()}
        currentModel={aiModel()}
        onClose={() => setPickerOpen(false)}
        onPick={async (id) => {
          setPickerOpen(false);
          try {
            await setAiModelChoice(id);
          } catch (e) {
            setError(String(e));
          }
        }}
      />

      <AIActivityDialog
        open={activityOpen()}
        onClose={() => {
          setActivityOpen(false);
          void refreshStats();
        }}
      />
    </section>
  );
};

type ModelPickerProps = {
  open: boolean;
  currentModel: string;
  onClose: () => void;
  onPick: (id: string) => void;
};

const ModelPicker: Component<ModelPickerProps> = (props) => {
  const [models, setModels] = createSignal<AiModel[]>([]);
  const [query, setQuery] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (!props.open) return;
    setQuery("");
    setErr(null);
    setLoading(true);
    api
      .listAiModels(false)
      .then((m) => setModels(m))
      .catch((e) => setErr(String(e)))
      .finally(() => {
        setLoading(false);
        queueMicrotask(() => inputRef?.focus());
      });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const filtered = createMemo(() => {
    const q = query().toLowerCase().trim();
    if (!q) return models();
    return models().filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  });

  return (
    <Show when={props.open}>
      <div class="nz-settings-backdrop nz-ai-picker-backdrop" onClick={props.onClose}>
        <div
          class="nz-ai-picker"
          role="dialog"
          aria-modal="true"
          aria-label="Pick a model"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="nz-ai-picker-header">
            <input
              ref={(el) => (inputRef = el)}
              class="nz-ai-picker-search"
              placeholder="Search models…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <button type="button" class="nz-trash-close" aria-label="Close" onClick={props.onClose}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="m3.5 3.5 7 7M10.5 3.5l-7 7"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
          <Show when={err()}>
            <p class="nz-settings-error" style={{ padding: "0 14px" }}>
              {err()}
            </p>
          </Show>
          <Show when={!loading()} fallback={<div class="nz-trash-loading">Loading models…</div>}>
            <ul class="nz-ai-picker-list">
              <Show
                when={filtered().length > 0}
                fallback={<li class="nz-ai-picker-empty">No matching models.</li>}
              >
                <For each={filtered()}>
                  {(m) => (
                    <li>
                      <button
                        type="button"
                        class="nz-ai-picker-row"
                        classList={{ active: m.id === props.currentModel }}
                        onClick={() => props.onPick(m.id)}
                      >
                        <div class="nz-ai-picker-row-main">
                          <span class="nz-ai-picker-name">{m.name}</span>
                          <span class="nz-ai-picker-id">{m.id}</span>
                        </div>
                        <span class="nz-ai-picker-price">
                          ${m.prompt_per_m.toFixed(2)} / ${m.completion_per_m.toFixed(2)}
                          <span class="nz-ai-picker-price-unit"> per 1M</span>
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </Show>
            </ul>
          </Show>
        </div>
      </div>
    </Show>
  );
};

const ChevronDown: Component = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path
      d="M2 4l3 3 3-3"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

function formatUsdCompact(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
