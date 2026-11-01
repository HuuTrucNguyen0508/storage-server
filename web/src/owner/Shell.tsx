import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { owner } from "../api";
import { filesHref, type Route } from "../paths";
import { usePhone } from "../ui/hooks";
import { Icon, Mark, type IconName } from "../ui/icons";
import { followLink, navigate } from "../ui/router";
import { UploadEngine } from "../uploads/engine";
import { RailTray } from "./Tray";

interface ShellValue {
  engine: UploadEngine;
  refreshCounts: () => void;
}

const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (value === null) throw new Error("useShell outside Shell");
  return value;
}

let engine: UploadEngine | null = null;

function NavLink({ to, icon, label, count, current }: { to: string; icon: IconName; label: string; count: number | null; current: boolean }) {
  return (
    <a href={to} aria-current={current ? "page" : undefined} onClick={(e) => followLink(e, to)}>
      <Icon name={icon} />
      {label}
      {count !== null && count > 0 && <span className="count">{count}</span>}
    </a>
  );
}

function SearchBox({ route }: { route: Route }) {
  const q = route.name === "files" ? route.q : "";
  const dir = route.name === "files" ? route.path : "";
  const [value, setValue] = useState(q);
  const input = useRef<HTMLInputElement>(null);
  const typed = useRef<number | undefined>(undefined);

  useEffect(() => setValue(q), [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (target.matches("input, textarea, select") || document.querySelector("dialog[open]") !== null) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const search = (text: string, replace: boolean) => {
    window.clearTimeout(typed.current);
    navigate(filesHref(dir, text.trim()), { replace });
  };

  return (
    <form
      className="field search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        search(value, false);
      }}
    >
      <Icon name="search" />
      <input
        ref={input}
        type="search"
        aria-label="Search by name"
        placeholder="Search by name"
        value={value}
        onChange={(e) => {
          const text = e.target.value;
          setValue(text);
          window.clearTimeout(typed.current);
          typed.current = window.setTimeout(() => search(text, q !== ""), 250);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value !== "") {
            e.stopPropagation();
            setValue("");
            search("", false);
          }
        }}
      />
      <kbd className="key">/</kbd>
    </form>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const [counts, setCounts] = useState<{ links: number; trash: number } | null>(null);
  const [tick, setTick] = useState(0);
  const value = useMemo(() => {
    engine ??= new UploadEngine({ kind: "owner", endpoint: "/api/uploads", destination: (path) => path });
    return { engine, refreshCounts: () => setTick((n) => n + 1) };
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([owner.shares(), owner.listTrash()]).then(
      ([shares, trash]) => {
        if (live) setCounts({ links: shares.length, trash: trash.length });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [tick]);

  const onFiles = route.name === "files";
  const phone = usePhone();
  return (
    <ShellContext.Provider value={value}>
      <div className="app">
        <aside className="rail">
          <a className="brand" href="/files/" onClick={(e) => followLink(e, "/files/")}>
            <Mark />
            storage
          </a>
          <nav className="nav" aria-label="Main">
            <NavLink to="/files/" icon="folderLine" label="Files" count={null} current={onFiles} />
            <NavLink to="/links" icon="link" label="Links" count={counts?.links ?? null} current={route.name === "links"} />
            <NavLink to="/trash" icon="trash" label="Trash" count={counts?.trash ?? null} current={route.name === "trash"} />
          </nav>
          {!phone && <RailTray engine={value.engine} />}
        </aside>
        <div className="main">
          <header className="topbar">
            <SearchBox route={route} />
            <a className="btn quiet icon" href="/account" aria-label="Account" aria-current={route.name === "account" ? "page" : undefined} onClick={(e) => followLink(e, "/account")}>
              <Icon name="account" />
            </a>
          </header>
          <main className="content">{children}</main>
        </div>
        <nav className="tabs" aria-label="Main">
          <NavLink to="/files/" icon="folderLine" label="Files" count={null} current={onFiles} />
          <NavLink to="/links" icon="link" label="Links" count={null} current={route.name === "links"} />
          <NavLink to="/trash" icon="trash" label="Trash" count={null} current={route.name === "trash"} />
        </nav>
      </div>
    </ShellContext.Provider>
  );
}
