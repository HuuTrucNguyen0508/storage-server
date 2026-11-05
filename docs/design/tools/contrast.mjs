#!/usr/bin/env node
// Measures WCAG 2.x contrast for the token pairs the UI actually uses, in
// both themes, straight from packages/ui/tokens.css. No dependencies.
//
//   node docs/design/tools/contrast.mjs > docs/design/contrast.txt
//
// Exit code 1 when any pair misses its target, so this can run in CI.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../../packages/ui/tokens.css"), "utf8");

// --- parse ---------------------------------------------------------------

function block(startMarker) {
  const i = css.indexOf(startMarker);
  if (i < 0) throw new Error(`marker not found: ${startMarker}`);
  const open = css.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === "{") depth++;
    if (css[j] === "}") depth--;
    if (depth === 0) return css.slice(open + 1, j);
  }
  throw new Error("unbalanced braces");
}

function vars(text) {
  const out = {};
  for (const m of text.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = vars(block("\n:root {"));
const dark = { ...light, ...vars(block(':root[data-theme="dark"]')) };

// --- color math ----------------------------------------------------------

function hex(h) {
  const s = h.replace("#", "");
  const n = parseInt(s.length === 3 ? s.replace(/./g, (c) => c + c) : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Resolves a token value to an sRGB triple. Supports hex, var(), and
// color-mix(in srgb, X p%, Y), which is what --*-wash tokens use.
function resolve_(theme, value, depth = 0) {
  if (depth > 10) throw new Error("token loop");
  value = value.trim();
  const v = value.match(/^var\(--([\w-]+)\)$/);
  if (v) return resolve_(theme, theme[v[1]], depth + 1);
  if (value.startsWith("#")) return hex(value);
  const mix = value.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*(.+)\)$/);
  if (mix) {
    const a = resolve_(theme, mix[1], depth + 1);
    const b = resolve_(theme, mix[3], depth + 1);
    const p = Number(mix[2]) / 100;
    return a.map((c, i) => Math.round(c * p + b[i] * (1 - p)));
  }
  throw new Error(`cannot resolve: ${value}`);
}

function luminance([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const toHex = (rgb) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

// --- the pairs -----------------------------------------------------------
// [foreground, background, minimum, what it is]
// 4.5 body text; 3 large text, icons, control borders, focus rings.

const accents = ["accent-lab", "accent-storage", "accent-todo"];

const pairs = [
  ["ink", "bg", 4.5, "body text on page"],
  ["ink", "surface", 4.5, "body text on panel"],
  ["ink", "surface-2", 4.5, "body text on table head / hover"],
  ["ink", "surface-3", 4.5, "body text on pressed"],
  ["ink-2", "bg", 4.5, "secondary text on page"],
  ["ink-2", "surface", 4.5, "secondary text on panel"],
  ["ink-2", "surface-2", 4.5, "secondary text on hover"],
  ["ink-3", "bg", 4.5, "muted text on page"],
  ["ink-3", "surface", 4.5, "muted text / placeholder on panel"],
  ["ink-3", "surface-2", 4.5, "muted text on table head"],
  ["line-strong", "surface", 3, "control border on panel"],
  ["line-strong", "bg", 3, "control border on page"],
  ["line-strong", "surface-2", 3, "control border on hover"],
  ["ok", "bg", 4.5, "success text on page"],
  ["ok", "surface", 4.5, "success text on panel"],
  ["warn", "bg", 4.5, "warning text on page"],
  ["warn", "surface", 4.5, "warning text on panel"],
  ["danger", "bg", 4.5, "danger text on page"],
  ["danger", "surface", 4.5, "danger text on panel"],
  ["on-status", "ok", 4.5, "text on success fill"],
  ["on-status", "warn", 4.5, "text on warning fill"],
  ["on-status", "danger", 4.5, "text on danger fill"],
  ["danger", "danger-wash", 4.5, "danger text on danger wash"],
  ["ok", "ok-wash", 4.5, "success text on success wash"],
  ["warn", "warn-wash", 4.5, "warning text on warning wash"],
];

for (const a of accents) {
  pairs.push(
    [a, "bg", 4.5, `${a} as link text on page`],
    [a, "surface", 4.5, `${a} as link text on panel`],
    [a, "surface-2", 4.5, `${a} as link text on hover`],
    ["on-accent", a, 4.5, `button text on ${a}`],
    [a, "bg", 3, `${a} focus ring on page`],
    [a, "surface", 3, `${a} focus ring on panel`],
  );
}

// Washes depend on --app-accent, so test them per app.
function appTheme(theme, accent) {
  return { ...theme, "app-accent": `var(--${accent})` };
}
const washPairs = [
  ["ink", "accent-wash", 4.5, "text on selected row"],
  ["ink-2", "accent-wash", 4.5, "secondary text on selected row"],
  ["app-accent", "accent-wash", 4.5, "accent text on selected row"],
  ["ink", "accent-wash-strong", 4.5, "text on strong wash"],
  ["app-accent", "accent-wash-strong", 3, "accent icon on strong wash"],
];

// --- run -----------------------------------------------------------------

let fails = 0;
let total = 0;
const lines = [];

function run(label, theme, list) {
  lines.push(`\n== ${label} ==`);
  for (const [fg, bg, min, what] of list) {
    const f = resolve_(theme, theme[fg]);
    const b = resolve_(theme, theme[bg]);
    const r = ratio(f, b);
    const ok = r >= min;
    total++;
    if (!ok) fails++;
    lines.push(
      `${ok ? "pass" : "FAIL"}  ${r.toFixed(2).padStart(5)}:1  (min ${min})  --${fg} ${toHex(f)} on --${bg} ${toHex(b)}  ${what}`,
    );
  }
}

for (const [name, theme] of [["light", light], ["dark", dark]]) {
  run(name, theme, pairs);
  for (const a of accents) run(`${name}, app-accent = ${a}`, appTheme(theme, a), washPairs);
}

const summary = `contrast: ${total - fails}/${total} pairs pass (${fails} fail), light + dark, measured from packages/ui/tokens.css`;
console.log(summary);
console.log(lines.join("\n"));
process.exit(fails ? 1 : 0);
