// Small shared building blocks on top of packages/ui/base.css.

import {
  createContext, type ReactNode, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { extLabel, iconClass } from "./format";

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

/** Returns the current URL with one query parameter set (or removed). */
export function withQuery(key: string, value: string | null): string {
  const u = new URL(location.href);
  if (value === null) u.searchParams.delete(key);
  else u.searchParams.set(key, value);
  return u.pathname + (u.search ? u.search : "");
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

export function FileIcon({ kind, name, large, className = "" }: { kind: string; name: string; large?: boolean; className?: string }) {
  const folder = kind === "folder";
  return (
    <svg viewBox="0 0 20 24" className={`ficon ${iconClass(kind, name)}${large ? " ficon--lg" : ""} ${className}`} aria-hidden="true" focusable="false">
      <use href={folder ? "#f-folder" : "#f-page"} />
      {!folder && (
        <text className="ficon__ext" x="10" y="19">
          {extLabel(name)}
        </text>
      )}
    </svg>
  );
}

// ---- focus management ----

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
  title, onClose, children, footer, size, icon,
}: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: "sm" | "lg"; icon?: ReactNode }) {
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
        className={`dialog${size ? " dialog--" + size : ""}`}
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

/** A one-field dialog for names (new folder, rename). */
export function NameDialog({
  title, label, initial, action, onSubmit, onClose,
}: { title: string; label: string; initial: string; action: string; onSubmit: (v: string) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    // Select the name without its extension, as file managers do.
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) {
      setError("Type a name.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(value);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? capitalize(err.message) + "." : "That didn't work. Try again.");
      setBusy(false);
    }
  };
  const errId = useId();
  return (
    <Dialog
      title={title}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit" form="name-form" disabled={busy}>
            {action}
          </button>
        </>
      }
    >
      <form id="name-form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">{label}</span>
          <input
            ref={input}
            data-autofocus
            className="input"
            value={value}
            maxLength={255}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError("");
            }}
          />
          {error && (
            <span className="field__error" id={errId}>
              {error}
            </span>
          )}
        </label>
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({
  title, children, action, danger, onConfirm, onClose,
}: { title: string; children: ReactNode; action: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void }) {
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

export const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// ---- menu ----

export interface MenuItem {
  label: string;
  icon?: string;
  kbd?: string;
  danger?: boolean;
  onSelect: () => void;
  separatorBefore?: boolean;
}

/** A popover menu anchored to a point; arrow keys move, Escape closes. */
export function Menu({ items, at, onClose, label }: { items: MenuItem[]; at: { x: number; y: number }; onClose: () => void; label: string }) {
  const ref = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, innerHeight - r.height - 8)) });
    el.querySelector<HTMLElement>("button")?.focus();
  }, [at]);
  useEffect(() => {
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose();
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const move = (dir: number) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
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
          onClose();
        }
      }}
    >
      {items.map((it) => (
        <MenuEntry key={it.label} it={it} onClose={onClose} />
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
          role="menuitem"
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          {it.icon && <Icon name={it.icon} />}
          {it.label}
          {it.kbd && <span className="menu__kbd">{it.kbd}</span>}
        </button>
      </li>
    </>
  );
}

// ---- toasts ----

interface Toast {
  id: number;
  text: string;
  tone?: "ok" | "danger" | "warn";
  action?: { label: string; run: () => void };
}

const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.tone === "danger" ? 8000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.tone ? " toast--" + t.tone : ""}`}>
            <span className="toast__text">{t.text}</span>
            {t.action && (
              <button
                className="toast__action btn btn--sm btn--quiet"
                onClick={() => {
                  t.action!.run();
                  setToasts((ts) => ts.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast__close btn btn--sm btn--quiet btn--icon" aria-label="Dismiss" onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>
              <Icon name="i-x" size="sm" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Error message for a toast. */
export function errorText(e: unknown): string {
  if (e instanceof Error && e.message) return capitalize(e.message) + ".";
  return "Something went wrong. Try again.";
}

// ---- theme ----

export type Theme = "system" | "light" | "dark";

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem("storage.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: Theme) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    if (t === "system") localStorage.removeItem("storage.theme");
    else localStorage.setItem("storage.theme", t);
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
      return (localStorage.getItem(key) as T) ?? initial;
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
