import type { ReactNode } from "react";

/**
 * A small Markdown reader that produces React elements, so there is no HTML
 * string anywhere to escape: a `<script>` in the file renders as those characters.
 * Images render as links, because the app loads no third-party asset.
 */
type Block =
  | { tag: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { tag: "paragraph"; text: string }
  | { tag: "code"; text: string }
  | { tag: "quote"; text: string }
  | { tag: "list"; ordered: boolean; items: string[] }
  | { tag: "rule" };

const LIST_ITEM = /^\s*(?:[-*+]|(\d+)\.)\s+(.*)$/;

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const at = (n: number) => lines[n] ?? "";
  while (i < lines.length) {
    const line = at(i);
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const end = fence[1] as string;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !at(i).trimStart().startsWith(end)) body.push(at(i++));
      i += 1;
      blocks.push({ tag: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading !== null) {
      const level = Math.min((heading[1] as string).length, 4) as 1 | 2 | 3 | 4;
      blocks.push({ tag: "heading", level, text: heading[2] as string });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ tag: "rule" });
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(at(i))) body.push(at(i++).replace(/^\s*>\s?/, ""));
      blocks.push({ tag: "quote", text: body.join(" ") });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      const ordered = item[1] !== undefined;
      const items: string[] = [];
      for (let m = LIST_ITEM.exec(at(i)); m !== null && (m[1] !== undefined) === ordered; m = LIST_ITEM.exec(at(i))) {
        items.push(m[2] as string);
        i += 1;
      }
      blocks.push({ tag: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && at(i).trim() !== "" && !/^(#{1,6}\s|\s*>|\s*(`{3,}|~{3,}))/.test(at(i)) && !LIST_ITEM.test(at(i))) {
      body.push(at(i++).trim());
    }
    blocks.push({ tag: "paragraph", text: body.join(" ") });
  }
  return blocks;
}

export type Inline =
  | { tag: "text"; text: string }
  | { tag: "code"; text: string }
  | { tag: "strong" | "em"; children: Inline[] }
  | { tag: "link"; href: string; children: Inline[] };

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest !== "") {
    const m = INLINE.exec(rest);
    if (m === null) {
      out.push({ tag: "text", text: rest });
      break;
    }
    if (m.index > 0) out.push({ tag: "text", text: rest.slice(0, m.index) });
    if (m[1] !== undefined) out.push({ tag: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ tag: "strong", children: parseInline((m[2] ?? m[3]) as string) });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ tag: "em", children: parseInline((m[4] ?? m[5]) as string) });
    else {
      const href = safeHref(m[7] as string);
      const label = parseInline(m[6] as string);
      if (href === null) out.push(...label);
      else out.push({ tag: "link", href, children: label });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.tag) {
      case "text":
        return node.text;
      case "code":
        return <code key={i}>{node.text}</code>;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "link":
        return (
          <a key={i} href={node.href} target="_blank" rel="noreferrer noopener">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose">
      {parseBlocks(source).map((block, i) => {
        const inline = (text: string) => renderInline(parseInline(text));
        switch (block.tag) {
          case "heading": {
            const Tag = `h${block.level}` as const;
            return <Tag key={i}>{inline(block.text)}</Tag>;
          }
          case "paragraph":
            return <p key={i}>{inline(block.text)}</p>;
          case "code":
            return (
              <pre key={i}>
                <code>{block.text}</code>
              </pre>
            );
          case "quote":
            return <blockquote key={i}>{inline(block.text)}</blockquote>;
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={i}>
                {block.items.map((item, n) => (
                  <li key={n}>{inline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "rule":
            return <hr key={i} />;
        }
      })}
    </div>
  );
}
