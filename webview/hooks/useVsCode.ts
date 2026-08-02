import { createContext, useContext } from "react";
import type { ContextMenuItem } from "../types";

export interface VsCodeApi {
  postMessage(message: Record<string, unknown>): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export const VsCodeContext = createContext<VsCodeApi | null>(null);

export function useVsCode(): VsCodeApi {
  const api = useContext(VsCodeContext);
  if (!api) throw new Error("useVsCode must be used within VsCodeContext");
  return api;
}

export function postMessage(api: VsCodeApi, message: Record<string, unknown>) {
  api.postMessage(message);
}

let closeCurrentContextMenu: (() => void) | undefined;

export function showContextMenu(
  event: React.MouseEvent,
  items: ContextMenuItem[],
  onAction: (message: Record<string, unknown>) => void,
) {
  event.preventDefault();
  event.stopPropagation();
  closeCurrentContextMenu?.();

  const menu = document.createElement("div");
  menu.className = "contextMenu";
  menu.style.left = event.clientX + "px";
  menu.style.top = event.clientY + "px";

  const close = () => {
    menu.remove();
    document.removeEventListener("click", handleOutsideMouse);
    document.removeEventListener("contextmenu", handleOutsideMouse);
    if (closeCurrentContextMenu === close) {
      closeCurrentContextMenu = undefined;
    }
  };

  const handleOutsideMouse = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      close();
    }
  };

  for (const item of items) {
    const btn = document.createElement("button");
    btn.textContent = item.label;
    btn.onclick = (e) => {
      e.stopPropagation();
      close();
      onAction(item.message);
    };
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  closeCurrentContextMenu = close;

  setTimeout(() => {
    if (closeCurrentContextMenu === close) {
      document.addEventListener("click", handleOutsideMouse);
      document.addEventListener("contextmenu", handleOutsideMouse);
    }
  }, 0);
}
