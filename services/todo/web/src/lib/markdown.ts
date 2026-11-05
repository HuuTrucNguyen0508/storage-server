// Task descriptions: Markdown with raw HTML disabled, sanitized again, and
// links opened safely. This is the only HTML the app sets directly.

import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

// Links open in a new tab without handing over window.opener.
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer");
  return defaultLink(tokens, idx, options, env, self);
};

/** Markdown source to sanitized HTML. */
export function sanitizedHtml(src: string): { __html: string } {
  const html = md.render(src);
  return {
    __html: DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "img", "form", "input", "iframe"],
      FORBID_ATTR: ["style"],
      ADD_ATTR: ["target"],
    }),
  };
}
