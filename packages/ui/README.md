# Lab UI

Two plain CSS files and the fonts they need. No framework, no build step of
its own. Storage, Todo and the Home portal all use them, so the apps look
like one place.

- `tokens.css`: custom properties for color (light and dark), type, space,
  radius, shadow, motion and the per-app accent.
- `base.css`: reset, typography, focus ring, and the component classes below.
- `fonts/`: IBM Plex Sans and Plex Mono as woff2, with their OFL licenses.

The design rationale and the rules are in `docs/design/direction.md`.

## Importing

From a Vite React app at `services/<app>/web/`, in your root stylesheet:

```css
@import "../../../packages/ui/tokens.css";
@import "../../../packages/ui/base.css";
```

Vite rewrites the `url(./fonts/…)` references in `base.css` and bundles the
woff2 files, so fonts load from the app's own origin. Then, in `index.html`:

```html
<html lang="en" data-app="storage">
```

`data-app` picks the accent: `storage` or `todo`. Anything else uses the
platform green. Nothing else is needed for dark mode; it follows the OS, and
`data-theme="light"` or `data-theme="dark"` on `<html>` pins it.

The Home portal is static and carries its own copy under
`services/home/site/ui/`. Keep it in sync with `packages/ui/` (copy the two
files and the `fonts/` folder) when either changes.

## Tokens you will reach for

| Token | Use |
|---|---|
| `--bg`, `--surface`, `--surface-2`, `--surface-3` | page, panel, hover/table head, pressed |
| `--ink`, `--ink-2`, `--ink-3` | text, secondary text, muted text and icons |
| `--line`, `--line-strong` | dividers; control borders (3:1 contrast) |
| `--app-accent`, `--on-accent` | the app color and the text that sits on it |
| `--accent-wash`, `--accent-wash-strong` | selected rows, active nav, pressed toggles |
| `--ok`, `--warn`, `--danger` and their `-wash` | status text and tinted backgrounds |
| `--fs-1` … `--fs-8` | 12, 13, 14, 16, 18, 22, 28, 36 px |
| `--sp-1` … `--sp-8` | 4, 8, 12, 16, 24, 32, 48, 64 px |
| `--r-1`, `--r-2`, `--r-3`, `--r-full` | chips, controls, panels, avatars |
| `--shadow-float` | menus, dialogs, toasts, tray |
| `--dur-1`, `--dur-2`, `--ease-out` | 120 ms, 180 ms |
| `--topbar-h`, `--sidebar-w`, `--panel-w`, `--control-h` | layout sizes |

## Class API

Names are `block__element`, `block--modifier`, `.is-state`. States that have
an ARIA attribute use the attribute instead of a class: `aria-current="page"`,
`aria-pressed`, `aria-selected`, `aria-invalid`, `aria-sort`.

### Top bar

```html
<header class="topbar">
  <a class="topbar__app" href="/">Storage</a>
  <nav class="topbar__nav" aria-label="Apps">
    <a class="topbar__link" href="https://home.…">Home</a>
    <a class="topbar__link" aria-current="page" href="/">Storage</a>
    <a class="topbar__link" href="https://todo.…">Todo</a>
    <a class="topbar__link" href="https://pdf.…">PDF</a>
    <a class="topbar__link" href="https://grafana.…">Grafana</a>
  </nav>
  <details class="switcher">              <!-- phones only -->
    <summary>Apps <svg class="icon icon--sm">…</svg></summary>
    <ul class="menu" role="menu">…menu__item per app…</ul>
  </details>
  <span class="topbar__spacer"></span>
  <button class="topbar__user" aria-haspopup="menu">
    <span class="avatar avatar--sm">A</span><span>Alice</span>
  </button>
</header>
```

The user menu is a `.menu` anchored under the button:

```html
<ul class="menu" role="menu">
  <li class="menu__user"><span class="avatar">A</span><div><strong>Alice</strong><span>alice@example.net</span></div></li>
  <li class="menu__sep" role="separator"></li>
  <li><a class="menu__item" role="menuitem" href="https://auth.…/logout?rd=https://home.…/">Sign out</a></li>
</ul>
```

### App shell

```html
<div class="app">
  <header class="topbar">…</header>
  <div class="app__body">              <!-- app__body--panel adds a right column -->
    <aside class="sidebar">
      <nav class="sidebar__group">
        <a class="nav__item" aria-current="page"><svg class="icon">…</svg><span class="nav__label">Files</span><span class="nav__count">3</span></a>
      </nav>
    </aside>
    <main class="main">…</main>       <!-- main--flush for full-bleed tables -->
    <aside class="panel">…</aside>     <!-- only with app__body--panel -->
  </div>
</div>
```

Breadcrumbs end in the page title:

```html
<nav class="crumbs" aria-label="Folder path">
  <a href="#">Files</a><span class="crumbs__sep"><svg class="icon">…</svg></span>
  <h1 class="crumbs__here">Lease renewal</h1>
</nav>
```

`page-head` (title plus actions), `toolbar`, `toolbar__spacer`, `selbar` (the
bar that replaces the toolbar while items are selected, with
`selbar__count`), and `actionbar` (phone-only fixed bottom buttons) complete
the shell.

### Buttons

```html
<button class="btn">Cancel</button>
<button class="btn btn--primary">Save changes</button>
<button class="btn btn--quiet">Later</button>
<button class="btn btn--danger">Delete forever</button>
<button class="btn btn--icon" aria-label="More"><svg class="icon">…</svg></button>
<button class="btn is-loading">Uploading</button>
```

Sizes `btn--sm`, `btn--lg`, `btn--block`. Grouped toggles:

```html
<div class="btn-group" role="group" aria-label="View">
  <button class="btn btn--icon" aria-pressed="true">…</button>
  <button class="btn btn--icon" aria-pressed="false">…</button>
</div>
```

`kbd` renders a key cap.

### Inputs

```html
<label class="field">
  <span class="field__label">Password</span>
  <input class="input" type="password" aria-describedby="h">
  <span class="field__help" id="h">Asked before the file shows.</span>
</label>
```

`field__error` with `aria-invalid="true"` on the input for errors.
`textarea`, `input--lg`, `input--sm`, `input--quiet` (no border until focus,
for inline rename and quick add). Leading icon:

```html
<label class="input-wrap"><svg class="icon">…</svg><input class="input" type="search" placeholder="Search files"><span class="kbd">/</span></label>
```

Select (wrap a native select so the chevron follows the theme):

```html
<span class="select"><select><option>Can view</option><option>Can edit</option></select></span>
```

`select--sm`, `select--quiet`. Checkbox, radio, switch:

```html
<input class="check" type="checkbox">        <!-- supports :indeterminate -->
<input class="check check--round p1" type="checkbox">   <!-- Todo completion, priority ring -->
<input class="radio" type="radio" name="r">
<input class="switch" type="checkbox" role="switch">
```

Segmented choice:

```html
<div class="seg" role="radiogroup" aria-label="Access">
  <label class="seg__opt"><input class="sr-only" type="radio" name="a" checked><span>Can view</span></label>
  <label class="seg__opt"><input class="sr-only" type="radio" name="a"><span>Can edit</span></label>
</div>
```

### Menus

```html
<ul class="menu" role="menu">
  <li><button class="menu__item" role="menuitem"><svg class="icon">…</svg>Rename<span class="menu__kbd">F2</span></button></li>
  <li class="menu__sep" role="separator"></li>
  <li><button class="menu__item menu__item--danger" role="menuitem">Move to trash</button></li>
</ul>
```

Position it yourself (`popover` is `position:absolute; z-index:40`).

### Dialogs

Works with native `<dialog>` (preferred) or a `div.overlay` wrapper:

```html
<dialog class="dialog" aria-labelledby="t">
  <div class="dialog__head"><h2 class="dialog__title" id="t">Share lease.pdf</h2><button class="btn btn--quiet btn--icon" aria-label="Close">…</button></div>
  <div class="dialog__body">…<div class="dialog__section">…</div></div>
  <div class="dialog__foot"><button class="btn btn--quiet btn--danger">Stop sharing</button><button class="btn btn--primary">Done</button></div>
</dialog>
```

`dialog--sm`, `dialog--lg`. Below 720 px every dialog becomes a bottom sheet.
A `btn--quiet` in the foot is pushed to the left.

### Toasts

```html
<div class="toasts" role="region" aria-live="polite">
  <div class="toast toast--ok"><span class="toast__text"><strong>Shared with Bob.</strong> He can view Flat photos.</span><button class="toast__action">Undo</button></div>
</div>
```

`toast--danger`, `toast--warn`. The spine color says what kind it is.

### Tables and lists

```html
<table class="table">
  <thead><tr>
    <th class="col-check"><input class="check" type="checkbox" aria-label="Select all"></th>
    <th aria-sort="ascending">Name</th><th class="hide-sm">Modified</th><th class="col-num">Size</th><th class="col-actions"></th>
  </tr></thead>
  <tbody>
    <tr class="is-selected">
      <td class="col-check"><input class="check" type="checkbox" checked></td>
      <td><div class="name-cell"><svg viewBox="0 0 20 24" class="ficon ficon--pdf">…</svg><a href="#">lease.pdf</a></div></td>
      <td class="hide-sm num">Today, 09:14</td>
      <td class="col-num">1.8 MB</td>
      <td class="col-actions"><span class="row-actions"><button class="btn btn--sm btn--quiet btn--icon">…</button></span></td>
    </tr>
  </tbody>
</table>
```

Row states: `is-selected`, `is-dragging`, `is-drop-target`. `table--compact`.
Wrap in `table-wrap` when it may overflow.

Generic list (members, shares, settings):

```html
<ul class="list list--boxed">
  <li class="list__item"><span class="avatar">B</span><div class="list__body"><div class="list__title">Bob</div><div class="list__meta">Added 2 Nov</div></div><div class="list__end">…</div></li>
</ul>
```

Grid view: `grid` > `tile` (`tile__check`, `tile__thumb`, `tile__name`,
`tile__meta`, `is-selected`).

### File icons

```html
<svg viewBox="0 0 20 24" class="ficon ficon--pdf">
  <path class="ficon__page" d="M3 1.5h9l5 5V22a.5.5 0 0 1-.5.5h-13A.5.5 0 0 1 3 22V2a.5.5 0 0 1 .5-.5z"/>
  <path d="M12 1.5v5h5" fill="none" stroke="currentColor" stroke-width="1.4"/>
  <text class="ficon__ext" x="10" y="19">PDF</text>
</svg>
```

The `viewBox` on the `<svg>` is required. Type modifiers: `ficon--folder`,
`--image`, `--video`, `--doc`, `--sheet`, `--pdf`, `--code`; size `ficon--lg`
(grid tiles, guest page). Folder path: `M1.5 6.5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z`.

### Empty states and skeletons

```html
<div class="empty">
  <div class="empty__icon"><svg class="icon">…</svg></div>
  <div class="empty__title">No files yet</div>
  <p class="empty__text">Drop files here or press Upload. Folders keep things findable later.</p>
  <div class="empty__actions"><button class="btn btn--primary">Upload</button></div>
</div>

<div class="skeleton-row"><span class="skeleton" style="width:1.25rem;height:1.5rem"></span><span class="skeleton skeleton--text"></span></div>
<span class="skeleton skeleton--text is-short"></span>
<span class="skeleton skeleton--circle" style="width:2rem;height:2rem"></span>
```

### Badges, labels, priority

```html
<span class="badge">Can view</span>
<span class="badge badge--accent">Can edit</span>
<span class="badge badge--ok">Done</span> <span class="badge badge--warn">Tomorrow</span> <span class="badge badge--danger">Failed</span>
<span class="badge badge--count">12</span>
<span class="label" style="--dot: var(--danger)">urgent</span>     <!-- Todo label -->
```

Priority classes `p1` … `p4` set `--p`, used by `check--round` for its ring.

### Progress

```html
<div class="progress"><div class="progress__bar" style="--value: 48%"></div></div>
<div class="progress progress--thin is-indeterminate"><div class="progress__bar"></div></div>
```

`progress--ok`, `--warn`, `--danger`. Sidebar quota: `meter`, `meter__row`.
Upload tray: `tray`, `tray__head`, `tray__item` (icon, `tray__name`,
`tray__state`, then a `progress`). Drag target: `dropzone` > `dropzone__card`.

### Todo rows and detail

```html
<ul class="tasks">
  <li class="task is-selected">
    <input class="check check--round p1" type="checkbox" aria-label="Complete Pay rent">
    <div>
      <div class="task__title">Pay rent</div>
      <div class="task__meta"><span class="task__due--today"><svg class="icon">…</svg>09:00</span><span class="task__project" style="--dot: var(--accent-todo)">Flat move</span><span class="label" style="--dot: var(--danger)">urgent</span></div>
    </div>
    <div class="task__end"><span class="avatar">B</span></div>
  </li>
</ul>
```

`is-done` strikes the title; `task__due--overdue`; `task--sub` for subtasks.
`section-head` (and `section-head--danger` for Overdue) heads each group.
Quick add: `quickadd` > icon + `input` + `quickadd__hint`. Detail panel:
`panel__head`, `panel__body`, `prop` / `prop__name` / `prop__value`, `chip`,
`chip--empty`, `comment`.

### Viewer

`viewer` (fixed, full screen) > `viewer__bar` (`viewer__title`,
`viewer__pager`) + `viewer__stage` (`--media` for the dark stage, `--doc` for
pages). `viewer__page` is a document sheet; `viewer__nav--prev/next` are the
round arrows. Code: `code` > `code__gutter` + `code__body`, with `tok-k`,
`tok-s`, `tok-c`, `tok-n` for keywords, strings, comments and numbers.
Markdown and the guest page use `prose`.

### Utilities

`h1`–`h4`, `display`, `text-1`, `text-2`, `muted`, `faint`, `mono`, `num`
(tabular figures), `measure`, `truncate`, `sr-only`, `stack`, `row`,
`row--between`, `grow`, `divider`, `spine`, `notice` (`--warn`, `--danger`,
`--ok`), `card`, `tabs`/`tab`, `hide-sm` (hidden ≤ 720 px), `hide-lg` (hidden
above 720 px).

## Checking contrast

```sh
node docs/design/tools/contrast.mjs > docs/design/contrast.txt
```

It exits non-zero if any token pair misses its target. Run it after any color
change.
