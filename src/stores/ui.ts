import { createSignal } from "solid-js";

const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
export { sidebarCollapsed, setSidebarCollapsed };

const [commandBarOpen, setCommandBarOpen] = createSignal(false);
export { commandBarOpen, setCommandBarOpen };

const [theme, setTheme] = createSignal<"light" | "dark" | "system">("system");
export { theme, setTheme };

export function toggleSidebar() {
  setSidebarCollapsed((v) => !v);
}

export function openCommandBar() {
  setCommandBarOpen(true);
}

export function closeCommandBar() {
  setCommandBarOpen(false);
}
