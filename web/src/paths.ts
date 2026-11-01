export interface Crumb {
  name: string;
  path: string;
}

export function join(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export function parent(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function crumbs(path: string): Crumb[] {
  if (path === "") return [];
  const names = path.split("/");
  return names.map((name, i) => ({ name, path: names.slice(0, i + 1).join("/") }));
}

export function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function filesHref(path: string, q?: string): string {
  const base = path === "" ? "/files/" : `/files/${encodePath(path)}`;
  return q ? `${base}?q=${encodeURIComponent(q)}` : base;
}

export function shareHref(token: string, path: string): string {
  return path === "" ? `/s/${token}` : `/s/${token}?path=${encodeURIComponent(path)}`;
}

export function flatName(relativePath: string): string {
  return baseName(relativePath);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The server sorts by bytes, which puts Z before a. People expect folders first, then names. */
export function displayOrder<T extends { name: string; kind: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || collator.compare(a.name, b.name));
}

export type Route =
  | { name: "home" }
  | { name: "files"; path: string; q: string }
  | { name: "links" }
  | { name: "trash" }
  | { name: "account" }
  | { name: "login" }
  | { name: "setup" }
  | { name: "unknown" };

export function parseRoute(pathname: string, search: string): Route {
  if (pathname === "/") return { name: "home" };
  if (pathname === "/files" || pathname.startsWith("/files/")) {
    const raw = pathname.slice("/files/".length).replace(/\/+$/, "");
    const path = raw === "" ? "" : raw.split("/").map(decodeURIComponent).join("/");
    return { name: "files", path, q: new URLSearchParams(search).get("q") ?? "" };
  }
  switch (pathname) {
    case "/links":
      return { name: "links" };
    case "/trash":
      return { name: "trash" };
    case "/account":
      return { name: "account" };
    case "/login":
      return { name: "login" };
    case "/setup":
      return { name: "setup" };
    default:
      return { name: "unknown" };
  }
}
