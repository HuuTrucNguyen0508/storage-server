import { useSyncExternalStore, type MouseEvent } from "react";

const CHANGE = "storage:navigate";

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(CHANGE, listener);
  };
}

const href = () => location.pathname + location.search;

export function useLocationKey(): string {
  return useSyncExternalStore(subscribe, href);
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === href()) return;
  history[options.replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new Event(CHANGE));
  window.scrollTo(0, 0);
}

export function followLink(event: MouseEvent<HTMLAnchorElement>, to: string): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(to);
}
