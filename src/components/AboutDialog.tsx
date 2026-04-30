import { type Component, Show, createEffect, onCleanup } from "solid-js";
import { APP_VERSION } from "../lib/version";
import { AgentZLogo } from "./AgentZLogo";

type Props = {
  open: boolean;
  onClose: () => void;
};

const AGENTZ_URL = "https://www.agent-z.de";

export const AboutDialog: Component<Props> = (props) => {
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
      <div class="nz-about-backdrop" onClick={props.onClose}>
        <div
          class="nz-about-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nz-about-title"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            class="nz-about-close"
            aria-label="Close"
            title="Close · esc"
            onClick={props.onClose}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="m3.5 3.5 7 7M10.5 3.5l-7 7"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>

          <div class="nz-about-hero">
            <div class="nz-about-app">
              <span class="nz-about-name">
                Note<span class="nz-about-name-z">Z</span>
              </span>
              <span class="nz-about-version">v{APP_VERSION}</span>
            </div>
            <p class="nz-about-tagline" id="nz-about-title">
              Fast, local, beautiful notes for Mac.
            </p>
          </div>

          <div class="nz-about-divider" />

          <div class="nz-about-section">
            <div class="nz-about-section-label">Made by</div>
            <a class="nz-about-brand" href={AGENTZ_URL} title="Open agent-z.de">
              <AgentZLogo class="nz-about-logo" height={28} />
            </a>
            <p class="nz-about-blurb">
              AgentZ Media is a social media agency from Schwerin, producing 365 videos a year for
              businesses - reach through content, not ads.
            </p>
            <a class="nz-about-link" href={AGENTZ_URL}>
              www.agent-z.de
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                <path
                  d="M4 2H9V7M9 2 3 8"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </a>
          </div>

          <div class="nz-about-footer">
            <span>© {new Date().getFullYear()} AgentZ Media</span>
            <span class="nz-about-footer-dot" aria-hidden="true">
              ·
            </span>
            <span>All rights reserved</span>
          </div>
        </div>
      </div>
    </Show>
  );
};
