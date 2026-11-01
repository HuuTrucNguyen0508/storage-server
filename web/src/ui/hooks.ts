import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type Loaded<T> = { tag: "loading" } | { tag: "ready"; value: T } | { tag: "failed"; error: unknown };

export function useLoad<T>(key: string, load: () => Promise<T>): { state: Loaded<T>; reload: () => Promise<void> } {
  const [state, setState] = useState<Loaded<T>>({ tag: "loading" });
  const latest = useRef(load);
  latest.current = load;
  const run = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++run.current;
    try {
      const value = await latest.current();
      if (mine === run.current) setState({ tag: "ready", value });
    } catch (error) {
      if (mine === run.current) setState({ tag: "failed", error });
    }
  }, []);

  useEffect(() => {
    setState({ tag: "loading" });
    void reload();
  }, [key, reload]);

  return { state, reload };
}

const PHONE = "(max-width: 720px)";

export function usePhone(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(PHONE);
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => window.matchMedia(PHONE).matches,
  );
}

export function useNow(): Date {
  const [now] = useState(() => new Date());
  return now;
}

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

let dismissCounter = 0;

export function useBackDismiss(active: boolean, dismiss: () => void): void {
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useEffect(() => {
    if (!active) return;
    const id = ++dismissCounter;
    history.pushState({ dismiss: id }, "");
    const onPop = () => {
      if ((history.state as { dismiss?: number } | null)?.dismiss !== id) latest.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if ((history.state as { dismiss?: number } | null)?.dismiss === id) history.back();
    };
  }, [active]);
}
