import { describe, expect, it } from "vitest";
import { baseName, crumbs, displayOrder, encodePath, filesHref, flatName, isMarkdown, join, parent, parseRoute, shareHref } from "./paths";

describe("paths", () => {
  it("joins onto the root without a leading slash", () => {
    expect(join("", "a.txt")).toBe("a.txt");
    expect(join("photos/2026", "a.txt")).toBe("photos/2026/a.txt");
  });

  it("takes the parent and the base name", () => {
    expect(parent("photos/2026/a.txt")).toBe("photos/2026");
    expect(parent("a.txt")).toBe("");
    expect(baseName("photos/2026/a.txt")).toBe("a.txt");
    expect(baseName("a.txt")).toBe("a.txt");
  });

  it("builds a crumb for each ancestor, ending at the path itself", () => {
    expect(crumbs("")).toEqual([]);
    expect(crumbs("photos/2026")).toEqual([
      { name: "photos", path: "photos" },
      { name: "2026", path: "photos/2026" },
    ]);
  });

  it("encodes each segment but keeps separators", () => {
    expect(encodePath("a b/ç#?.txt")).toBe("a%20b/%C3%A7%23%3F.txt");
  });

  it("round-trips an awkward path through a route", () => {
    const href = filesHref("a b/100%/ç#x", "red fox");
    const url = new URL(href, "http://x");
    expect(href).toBe("/files/a%20b/100%25/%C3%A7%23x?q=red%20fox");
    expect(parseRoute(url.pathname, url.search)).toEqual({ name: "files", path: "a b/100%/ç#x", q: "red fox" });
  });

  it("parses the root and every owner page", () => {
    expect(parseRoute("/", "")).toEqual({ name: "home" });
    expect(parseRoute("/files/", "")).toEqual({ name: "files", path: "", q: "" });
    expect(parseRoute("/files", "")).toEqual({ name: "files", path: "", q: "" });
    expect(parseRoute("/links", "")).toEqual({ name: "links" });
    expect(parseRoute("/trash", "")).toEqual({ name: "trash" });
    expect(parseRoute("/account", "")).toEqual({ name: "account" });
    expect(parseRoute("/nope", "")).toEqual({ name: "unknown" });
  });

  it("keeps a guest's folder in the query, because the guest listener refuses a deeper path", () => {
    expect(shareHref("tok", "")).toBe("/s/tok");
    expect(shareHref("tok", "a b/c")).toBe("/s/tok?path=a%20b%2Fc");
  });

  it("flattens a dropped folder's path to its file name", () => {
    expect(flatName("holiday/day 1/a.jpg")).toBe("a.jpg");
  });

  it("lists folders first, then names as a person reads them", () => {
    const entries = [
      { name: "b.txt", kind: "file" },
      { name: "Zoo", kind: "dir" },
      { name: "A.txt", kind: "file" },
      { name: "img10.jpg", kind: "file" },
      { name: "img9.jpg", kind: "file" },
      { name: "apple", kind: "dir" },
    ];
    expect(displayOrder(entries).map((e) => e.name)).toEqual(["apple", "Zoo", "A.txt", "b.txt", "img9.jpg", "img10.jpg"]);
  });

  it("recognises Markdown by extension in any case", () => {
    expect(isMarkdown("NOTES.MD")).toBe(true);
    expect(isMarkdown("notes.txt")).toBe(false);
  });
});
