import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "./Markdown";

describe("parseBlocks", () => {
  it("reads headings, paragraphs, lists, quotes, code and rules", () => {
    const source = ["# Title", "", "one", "two", "", "- a", "- b", "", "1. x", "", "> said", "", "```", "<b>raw</b>", "```", "", "---"].join("\n");
    expect(parseBlocks(source)).toEqual([
      { tag: "heading", level: 1, text: "Title" },
      { tag: "paragraph", text: "one two" },
      { tag: "list", ordered: false, items: ["a", "b"] },
      { tag: "list", ordered: true, items: ["x"] },
      { tag: "quote", text: "said" },
      { tag: "code", text: "<b>raw</b>" },
      { tag: "rule" },
    ]);
  });

  it("keeps raw HTML as text", () => {
    expect(parseBlocks("<script>alert(1)</script>")).toEqual([{ tag: "paragraph", text: "<script>alert(1)</script>" }]);
  });

  it("does not hang on an unclosed fence", () => {
    expect(parseBlocks("```\nabc")).toEqual([{ tag: "code", text: "abc" }]);
  });
});

describe("parseInline", () => {
  it("reads emphasis, strong, code and links", () => {
    expect(parseInline("a **b** *c* `d` [e](https://x.test/)")).toEqual([
      { tag: "text", text: "a " },
      { tag: "strong", children: [{ tag: "text", text: "b" }] },
      { tag: "text", text: " " },
      { tag: "em", children: [{ tag: "text", text: "c" }] },
      { tag: "text", text: " " },
      { tag: "code", text: "d" },
      { tag: "text", text: " " },
      { tag: "link", href: "https://x.test/", children: [{ tag: "text", text: "e" }] },
    ]);
  });

  it("drops a javascript: link to its label", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { tag: "text", text: "click" },
      { tag: "text", text: ")" },
    ]);
  });

  it("drops a relative link, which would point into the app", () => {
    expect(parseInline("[x](/api/logout)")).toEqual([{ tag: "text", text: "x" }]);
  });

  it("turns an image into a link so nothing third-party loads", () => {
    expect(parseInline("![cat](https://x.test/c.png)")).toEqual([
      { tag: "link", href: "https://x.test/c.png", children: [{ tag: "text", text: "cat" }] },
    ]);
  });
});
