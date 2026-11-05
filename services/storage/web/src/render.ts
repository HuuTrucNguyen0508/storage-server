// Turning user text into something safe to show. Markdown has raw HTML
// disabled and its output goes through DOMPurify; code is escaped by
// highlight.js; nothing here ever executes user content.

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import MarkdownIt from "markdown-it";

const languages = {
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, lua, makefile,
  markdown, php, plaintext, python, ruby, rust, sql, swift, typescript, xml, yaml,
};
for (const [name, lang] of Object.entries(languages)) hljs.registerLanguage(name, lang);
const aliases: Record<string, string> = { scss: "css", less: "css", properties: "ini", groovy: "java", hcl: "ini", toml: "ini", powershell: "bash", protobuf: "plaintext" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** Highlighted HTML for code; unknown languages come back escaped. */
export function highlight(text: string, language?: string): string {
  const lang = language ? (aliases[language] ?? language) : undefined;
  if (lang && hljs.getLanguage(lang) && text.length < 512 * 1024) {
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(text);
}

const md = new MarkdownIt({
  html: false, // raw HTML in a file is shown as text, never parsed
  linkify: true,
  typographer: false,
  highlight: (code, lang) => highlight(code, lang || "plaintext"),
});

// Only http(s), mailto and in-page links survive.
md.validateLink = (url: string) => /^(https?:|mailto:|#)/i.test(url.trim());

let hooked = false;

/** Markdown to sanitized HTML. */
export function renderMarkdown(src: string): string {
  if (!hooked) {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      }
    });
    hooked = true;
  }
  return DOMPurify.sanitize(md.render(src), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
}

/** Pretty-printed JSON, or null when the text is not valid JSON. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** Splits text into lines for the gutter, without a phantom last line. */
export function lineCount(text: string): number {
  if (text === "") return 1;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** Cuts a truncated text preview at its last full line (and a whole UTF-8 character). */
export function trimPartial(text: string, truncated: boolean): string {
  if (!truncated) return text;
  const cut = text.lastIndexOf("\n");
  return cut > 0 ? text.slice(0, cut + 1) : text.replace(/�+$/, "");
}
