#!/usr/bin/env node
// Assembles docs/design/mockups/*.html from pages/*.html fragments plus the
// shared shell (icon sprite, top bar, sidebars), so the chrome is written
// once. The output is plain static HTML that imports the real tokens and
// base CSS from packages/ui.
//
//   node docs/design/tools/mockups/build.mjs
//
// Fragment header (HTML comments on the first lines):
//   <!-- title: Storage, grid view -->
//   <!-- app: storage | todo | home -->
//   <!-- shell: storage | todo | viewer | public -->

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = resolve(here, "pages");
const outDir = resolve(here, "../../mockups");

const sprite = readFileSync(resolve(here, "sprite.svg"), "utf8");

const apps = [
  ["home", "Home"],
  ["storage", "Storage"],
  ["todo", "Todo"],
  ["pdf", "PDF"],
  ["grafana", "Grafana"],
];

function topbar(app, user = "Alice") {
  const name = apps.find(([k]) => k === app)?.[1] ?? "Lab";
  const links = apps
    .map(([k, label]) => `<a class="topbar__link"${k === app ? ' aria-current="page"' : ""} href="#">${label}</a>`)
    .join("\n      ");
  const items = apps
    .map(([k, label]) => `<li><a class="menu__item" role="menuitem"${k === app ? ' aria-current="true"' : ""} href="#">${label}</a></li>`)
    .join("\n        ");
  return `  <header class="topbar">
    <a class="topbar__app" href="#">${name}</a>
    <nav class="topbar__nav" aria-label="Apps">
      ${links}
    </nav>
    <details class="switcher">
      <summary>Apps <svg class="icon icon--sm"><use href="#i-chev-d"/></svg></summary>
      <ul class="menu" role="menu">
        ${items}
      </ul>
    </details>
    <span class="topbar__spacer"></span>
    <button class="topbar__user" aria-haspopup="menu"><span class="avatar avatar--sm">${user[0]}</span><span>${user}</span><svg class="icon icon--sm hide-sm"><use href="#i-chev-d"/></svg></button>
  </header>`;
}

function storageSidebar(current) {
  const item = (key, icon, label, count) =>
    `<a class="nav__item"${current === key ? ' aria-current="page"' : ""} href="#"><svg class="icon"><use href="#i-${icon}"/></svg><span class="nav__label">${label}</span>${count ? `<span class="nav__count">${count}</span>` : ""}</a>`;
  return `    <aside class="sidebar">
      <button class="btn btn--primary"><svg class="icon"><use href="#i-upload"/></svg>Upload</button>
      <nav class="sidebar__group" aria-label="Storage">
        ${item("files", "folder", "Files")}
        ${item("shared", "share", "Shared with me", 3)}
        ${item("links", "link", "Links", 2)}
        ${item("trash", "trash", "Trash")}
      </nav>
      <div class="meter" style="margin-top:auto">
        <div class="meter__row"><strong>61.2 GB used</strong><span>of 200 GB</span></div>
        <div class="progress progress--thin"><div class="progress__bar" style="--value:31%"></div></div>
        <span>Photos 2026 is the largest folder.</span>
      </div>
    </aside>`;
}

function todoSidebar(current) {
  const smart = (key, icon, label, count) =>
    `<a class="nav__item"${current === key ? ' aria-current="page"' : ""} href="#"><svg class="icon"><use href="#i-${icon}"/></svg><span class="nav__label">${label}</span>${count ? `<span class="nav__count">${count}</span>` : ""}</a>`;
  const project = (key, color, label, count, shared) =>
    `<a class="nav__item"${current === key ? ' aria-current="page"' : ""} href="#"><span class="nav__dot" style="background:${color}"></span><span class="nav__label">${label}</span>${shared ? '<svg class="icon icon--sm faint" aria-label="Shared"><use href="#i-share"/></svg>' : ""}${count ? `<span class="nav__count">${count}</span>` : ""}</a>`;
  return `    <aside class="sidebar">
      <button class="btn btn--primary"><svg class="icon"><use href="#i-plus"/></svg>Add task<span class="kbd" style="margin-left:auto;background:transparent;border-color:transparent;color:inherit;opacity:.8">Q</span></button>
      <nav class="sidebar__group" aria-label="Views">
        ${smart("inbox", "inbox", "Inbox", 4)}
        ${smart("today", "today", "Today", 6)}
        ${smart("upcoming", "calendar", "Upcoming")}
        ${smart("overdue", "alert", "Overdue", 2)}
        ${smart("done", "check-circle", "Completed")}
      </nav>
      <nav class="sidebar__group" aria-label="Projects">
        <div class="sidebar__heading"><span>Projects</span><button class="btn btn--sm btn--quiet btn--icon" aria-label="New project"><svg class="icon"><use href="#i-plus"/></svg></button></div>
        ${project("flat", "var(--accent-todo)", "Flat move", 9, true)}
        ${project("server", "var(--accent-storage)", "Home server", 5)}
        ${project("trip", "var(--accent-lab)", "Hanoi trip", 12, true)}
        ${project("reading", "var(--ink-3)", "Reading list", 3)}
      </nav>
      <nav class="sidebar__group" aria-label="Labels">
        <div class="sidebar__heading"><span>Labels</span></div>
        <a class="nav__item" href="#"><span class="label" style="--dot:var(--danger)">urgent</span></a>
        <a class="nav__item" href="#"><span class="label" style="--dot:var(--ok)">errand</span></a>
        <a class="nav__item" href="#"><span class="label" style="--dot:var(--accent-storage)">waiting</span></a>
      </nav>
    </aside>`;
}

function head(title, app) {
  return `<!doctype html>
<html lang="en" data-app="${app}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="../../../packages/ui/tokens.css">
  <link rel="stylesheet" href="../../../packages/ui/base.css">
  <link rel="stylesheet" href="./mock.css">
  <script src="./mock.js"></script>
</head>
<body>
${sprite}
`;
}

function meta(src) {
  const out = {};
  for (const m of src.matchAll(/^<!--\s*(\w+):\s*(.+?)\s*-->$/gm)) out[m[1]] = m[2];
  return out;
}

const generated = `<!-- Generated by docs/design/tools/mockups/build.mjs from pages/; edit the fragment, not this file. -->\n`;

for (const file of readdirSync(pagesDir).filter((f) => f.endsWith(".html"))) {
  const src = readFileSync(resolve(pagesDir, file), "utf8");
  const m = meta(src);
  // File icons need the 20x24 viewBox on the <svg> itself so the extension
  // label scales with the icon; the sprite's symbol only sizes the page shape.
  const body = src
    .replace(/^<!--\s*\w+:.*-->\n/gm, "")
    .replace(/<svg class="ficon/g, '<svg viewBox="0 0 20 24" class="ficon');
  const app = m.app ?? "storage";
  let html = head(m.title ?? basename(file, ".html"), app);
  switch (m.shell) {
    case "storage":
      html += `<div class="app">\n${topbar(app)}\n  <div class="app__body">\n${storageSidebar(m.nav ?? "files")}\n${body}\n  </div>\n</div>\n`;
      break;
    case "todo":
      html += `<div class="app">\n${topbar(app)}\n  <div class="app__body app__body--panel">\n${todoSidebar(m.nav ?? "today")}\n${body}\n  </div>\n</div>\n`;
      break;
    case "viewer":
    case "public":
      html += body + "\n";
      break;
    default:
      throw new Error(`${file}: unknown shell ${m.shell}`);
  }
  html += "</body>\n</html>\n";
  writeFileSync(resolve(outDir, file), generated + html);
  console.log(`wrote ${file}`);
}
