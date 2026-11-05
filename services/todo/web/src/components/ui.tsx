// Shared building blocks on top of ui/base.css (same patterns as the storage app).

import {
  createContext, type ReactNode, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { ToastInput } from "../data/writer";

// ---- router ----

const routeListeners = new Set<() => void>();
window.addEventListener("popstate", () => routeListeners.forEach((f) => f()));

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  routeListeners.forEach((f) => f());
}

export function useLocation(): { path: string; query: URLSearchParams } {
  const href = useSyncExternalStore(
    (f) => {
      routeListeners.add(f);
      return () => routeListeners.delete(f);
    },
    () => location.pathname + location.search,
  );
  const u = new URL(href, location.origin);
  return { path: u.pathname, query: u.searchParams };
}

/** The current URL with query parameters set (null removes one). */
export function withQuery(changes: Record<string, string | null>): string {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === "") u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  return u.pathname + u.search;
}

/** An <a> that navigates without reloading. */
export function A({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

// ---- icons ----

export function Icon({ name, size, className = "", label }: { name: string; size?: "sm" | "lg"; className?: string; label?: string }) {
  return (
    <svg
      className={`icon${size ? " icon--" + size : ""}${className ? " " + className : ""}`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    >
      <use href={`#${name}`} />
    </svg>
  );
}

export function Avatar({ name, size }: { name: string; size?: "sm" }) {
  return (
    <span className={`avatar${size ? " avatar--" + size : ""}`} title={name} aria-hidden="true">
      {(name[0] ?? "?").toUpperCase()}
    </span>
  );
}

// ---- focus ----

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab inside el, focuses the first field, and restores focus on close. */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const before = document.activeElement as HTMLElement | null;
    const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (items.length === 0) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      if (before && document.contains(before)) before.focus();
    };
  }, [ref, active]);
}

// ---- dialog ----

export function Dialog({
  title, onClose, children, footer, size, icon, className = "",
}: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: "sm" | "lg"; icon?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref);
  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog${size ? " dialog--" + size : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="dialog__head">
          {icon}
          <h2 className="dialog__title" id={id}>
            {title}
          </h2>
          <button className="btn btn--quiet btn--icon" aria-label="Close" onClick={onClose}>
            <Icon name="i-x" />
          </button>
        </div>
        <div className="dialog__body">{children}</div>
        {footer && <div className="dialog__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title, children, action, danger, onConfirm, onClose,
}: { title: string; children: ReactNode; action: string; danger?: boolean; onConfirm: () => Promise<unknown> | unknown; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "btn--danger" : "btn--primary"}`}
            data-autofocus
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                onClose();
              }
            }}
          >
            {action}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

// ---- menu ----

export interface MenuItem {
  label: string;
  icon?: string;
  kbd?: string;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  separatorBefore?: boolean;
  dot?: string;
}

export type MenuAnchor = { x: number; y: number };

export function anchorBelow(el: Element, alignRight = false, width = 220): MenuAnchor {
  const r = el.getBoundingClientRect();
  return { x: alignRight ? r.right - width : r.left, y: r.bottom + 4 };
}

/** A popover menu anchored to a point; arrow keys move, Escape closes, focus returns to the opener. */
export function Menu({ items, at, onClose, label }: { items: MenuItem[]; at: MenuAnchor; onClose: () => void; label: string }) {
  const ref = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState(at);
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const close = useCallback(() => {
    onClose();
    const o = opener.current;
    if (o && document.contains(o)) o.focus();
  }, [onClose]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, innerHeight - r.height - 8)) });
    (el.querySelector<HTMLElement>('button[aria-checked="true"]') ?? el.querySelector<HTMLElement>("button:not([disabled])"))?.focus();
  }, [at]);
  useEffect(() => {
    const down = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", down);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const move = (dir: number) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + dir + buttons.length) % buttons.length]?.focus();
  };
  return createPortal(
    <ul
      ref={ref}
      className="menu popover"
      role="menu"
      aria-label={label}
      style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 60 }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      {items.map((it, i) => (
        <MenuEntry key={it.label + i} it={it} onClose={close} />
      ))}
    </ul>,
    document.body,
  );
}

function MenuEntry({ it, onClose }: { it: MenuItem; onClose: () => void }) {
  return (
    <>
      {it.separatorBefore && <li className="menu__sep" role="separator" />}
      <li role="none">
        <button
          className={`menu__item${it.danger ? " menu__item--danger" : ""}`}
          role={it.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={it.checked === undefined ? undefined : it.checked}
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          {it.dot ? <span className="nav__dot" style={{ background: it.dot }} /> : it.icon ? <Icon name={it.icon} /> : null}
          <span className="grow">{it.label}</span>
          {it.checked && <Icon name="i-check" className="menu__check" />}
          {it.kbd && <span className="menu__kbd">{it.kbd}</span>}
        </button>
      </li>
    </>
  );
}

// ---- toasts ----

interface Toast extends ToastInput {
  id: number;
}

const ToastCtx = createContext<(t: ToastInput) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((x) => x.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);
  const schedule = useCallback(
    (t: Toast) => {
      timers.current.set(t.id, setTimeout(() => dismiss(t.id), t.timeout ?? (t.tone === "danger" ? 8000 : t.action ? 6000 : 4000)));
    },
    [dismiss],
  );
  const push = useCallback(
    (t: ToastInput) => {
      const toast = { ...t, id: Date.now() + Math.random() };
      setToasts((ts) => [...ts.slice(-3), toast]);
      schedule(toast);
    },
    [schedule],
  );
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-label="Notifications">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast${t.tone ? " toast--" + t.tone : ""}`}
              onMouseEnter={() => clearTimeout(timers.current.get(t.id))}
              onMouseLeave={() => schedule(t)}
              onFocus={() => clearTimeout(timers.current.get(t.id))}
            >
              <span className="toast__text">{t.text}</span>
              {t.action && (
                <button
                  className="toast__action btn btn--sm btn--quiet"
                  onClick={() => {
                    t.action!.run();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button className="toast__close btn btn--sm btn--quiet btn--icon" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <Icon name="i-x" size="sm" />
              </button>
            </div>
          ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---- theme ----

export type Theme = "system" | "light" | "dark";

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem("todo.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: Theme) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    if (t === "system") localStorage.removeItem("todo.theme");
    else localStorage.setItem("todo.theme", t);
  } catch {
    /* private mode */
  }
}

/** Whether a keyboard shortcut should be ignored because the user is typing. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export function usePersisted<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = (nv: T) => {
    setV(nv);
    try {
      localStorage.setItem(key, nv);
    } catch {
      /* ignore */
    }
  };
  return [v, set];
}

export function useMediaQuery(q: string): boolean {
  return useSyncExternalStore(
    (f) => {
      const m = matchMedia(q);
      m.addEventListener("change", f);
      return () => m.removeEventListener("change", f);
    },
    () => matchMedia(q).matches,
  );
}
