# Design direction

One visual language for Home, Storage and Todo. This file says what the
language is and the rules an implementer follows. The tokens are in
`packages/ui/tokens.css`, the components in `packages/ui/base.css`, the class
API in `packages/ui/README.md`, and the proof in `docs/design/mockups/` and
`docs/design/contrast.txt`.

## The idea: a shared shelf

This is not a product. It is one person's server, opened to a few friends. The
closest physical thing is a well-kept shelf of labelled binders in a shared
flat: plain, dense, trustworthy, and yours. The interface should feel like a
tool that was set up with care, not a startup that wants a sign-up.

So the design is quiet and exact. Type does the talking. Color appears in one
place with full strength and is otherwise a wash. Nothing moves unless you
moved it. Copy says what happens, in the second person, in sentence case.

The one memorable element is the **spine**: a 4 px vertical bar in the app's
color on the left edge of the top bar's app name, of a selected row, of a
notice, of a toast and of each door on the Home portal. It is the colored
label on a binder's spine. Everything else is grey, white and ink.

## Type

IBM Plex Sans, self-hosted (OFL, in `packages/ui/fonts/`), weights 400, 500
and 600 plus 400 italic. Plex Mono, 400, only for code, paths, hashes and
share links. Numbers in tables use tabular figures from Plex Sans, never the
mono face. Latin, Latin Extended and Vietnamese subsets are included so names
with diacritics set in the same face.

Scale (px): 12, 13, 14, 16, 18, 22, 28, 36. App body is 14 px; reading
surfaces (Home, public share page, markdown preview) are 16 px. Headings are
600 with slight negative tracking; UI labels 500; body 400. Line length is
capped at 68 ch wherever there is prose.

The current folder is the page title (22 px, 600) at the end of the
breadcrumb, so the user never reads the same name twice.

Not allowed: all-caps labels, tracked-out eyebrows, a lone accent-colored word
inside a heading, arrows appended to link text, meta strings joined with
middle dots.

## Color

Light theme: a cool grey-green paper `#f1f3f0` for the page, white panels,
ink `#1b201e`. Dark theme: a clearly green-black slate `#151a18`, panels
`#1c2220`, ink `#e7ebe8`. It is a tinted dark on purpose, not `#111`.

One accent per app, set through `--app-accent`:

| App | Light | Dark | Why |
|---|---|---|---|
| Platform (Home, auth, top bar fallbacks) | `#1f6f5e` | `#5fc8ad` | a lab green: the host, not any one app |
| Storage | `#2956b8` | `#93b6ff` | cobalt, like the archive boxes |
| Todo | `#8a5100` | `#e6b35a` | ochre, like a pencil mark |

Third-party apps (Stirling PDF, Grafana) keep their own look inside; on Home
their doors borrow the platform green because we don't paint other people's
products.

Status colors are shared: ok green, warn ochre (same hue as Todo, which is
fine: in Todo, urgency is red and ochre is the brand, not a warning), danger
red. In dark mode accents are lifted so they work as text on the background,
and primary buttons flip to dark text on a light fill.

Washes (`--accent-wash`, 12 % accent over the surface; 16 % in dark) mark
selected rows, the active nav item and pressed toggles. Full-strength accent
is for the spine, primary buttons, links, the focus ring and checked boxes.
Nowhere else.

Contrast is measured, not guessed. `docs/design/tools/contrast.mjs` reads the
token file and checks 116 foreground/background pairs across both themes and
all three accents: body text at 4.5:1 or better, large text, icons, control
borders and focus rings at 3:1 or better. The last run is in
`docs/design/contrast.txt`. Change a color, run it again.

## Spacing, shape, depth

A 4 px grid; the usual steps are 8, 12, 16, 24, 32, 48. Controls are 32 px
tall, 40 px on Home and public pages. The top bar is 48 px, the sidebar 240
px, the Todo detail panel 352 px.

Radius encodes hierarchy: 3 px for chips and badges, 5 px for controls, 8 px
for panels, dialogs and tiles. Avatars are round. Nothing else is.

No shadows on content. Cards are a 1 px line on the page color. Shadows exist
only on floating layers: menus, dialogs, toasts and the upload tray. One
shadow token each for floating and for the phone bottom sheet.

Borders: dividers use `--line`, which is decorative and may be faint. Anything
that must be found by eye to be used (inputs, buttons, checkboxes) uses
`--line-strong`, which is held at 3:1 against every surface it sits on.

## Motion

Only in answer to an action. Menus and dialogs scale from 0.98 and fade over
180 ms; state changes (hover, checked, selected) take 120 ms; progress bars
animate width. Nothing animates on page load, no sections slide in, no cards
lift on hover. `prefers-reduced-motion` sets both durations to 0.

## Iconography

Inline SVG on a 16 px grid, 1.5 px stroke, round caps and joins, `currentColor`.
The sprite for the mockups is `docs/design/tools/mockups/sprite.svg`; apps copy
the paths they need into their own components. Icons never carry meaning alone:
a label or an `aria-label` goes with them.

File icons are one shape, a page outline, with the extension written on it.
Folders are a filled folder. Type color is a hint (red for PDF and video,
cobalt for documents, green for spreadsheets, lab green for images), not a
rainbow: at rest the icon is muted ink.

## How one language covers three apps

- The same top bar, from `base.css`, on every app: spine and app name on the
  left, the five-app switcher, the signed-in user on the right with sign-out
  in the user menu. On phones the switcher collapses to an "Apps" menu.
- The same shell: a 240 px sidebar on the page color, a white main area, an
  optional right panel. Storage puts Files, Shared with me, Links and Trash
  in the sidebar with the quota meter at the bottom; Todo puts smart views,
  projects and labels there.
- The same rows. A file row and a task row share height, hover, selection wash
  and the spine on selection. Multi-select in both replaces the toolbar with a
  selection bar.
- The same dialogs, menus, toasts, empty states and skeletons, styled once.
- Only `--app-accent` changes. Set `data-app="storage"` or `data-app="todo"`
  on `<html>` and the whole app follows.

## Writing

Sentence case everywhere. Buttons say what happens: "Share", "Move to trash",
"Open file". The toast that follows uses the same verb: "Shared with Bob."
Errors say what went wrong and what to do: "That password didn't match. Ask
Alice for the current one." Empty states invite an action and explain the
space in one line. Numbers are written for people: "1.2 GB left, about 4 min",
"8 downloads left", "29 days left".

## Rules for implementers

1. Import `tokens.css` then `base.css`; never write a hex color in an app.
2. Set `data-app` on `<html>` for Storage and Todo. Home and anything else keep
   the platform green.
3. Use the classes in `packages/ui/README.md`; add app-specific classes in the
   app's own stylesheet, built from tokens. Don't fork `base.css`.
4. Keep the spine: selected rows, notices, toasts and the top bar app name
   carry it. Don't add a second accent treatment.
5. No page-load animation. Motion only answers a user action, and the
   reduced-motion query must zero it.
6. Every interactive element shows the focus ring (`:focus-visible` is styled
   once in `base.css`; don't remove outlines).
7. Icons are inline SVG with `class="icon"`, 1.5 stroke, `currentColor`, plus
   a visible label or `aria-label`.
8. Tables: numbers right-aligned with `col-num`; dates and sizes in Plex Sans
   tabular figures; the actions column shows on hover and on focus-within.
9. On phones (≤ 720 px): the sidebar and panel hide, the switcher becomes a
   menu, dialogs become bottom sheets, primary actions move to `.actionbar`,
   and secondary columns use `hide-sm`.
10. Fonts load from the app's own origin. No CDN, no Google Fonts request.

## Taste calls made without asking

- IBM Plex over Inter or system fonts: it reads as engineered and legible at
  13 px in dense tables, and ships Vietnamese glyphs.
- Ochre for Todo, not purple or green: green already means "done", purple is
  every SaaS. Ochre is a pencil, which is what a todo list is.
- A tinted dark theme rather than pure black, so the washes still read.
- Home opens with the wordmark, the real domain and four doors, not a hero
  image or a stat row. The number keys 1–4 are real shortcuts, so the small
  key caps on the doors encode a function rather than decorate.
- Primary buttons in dark mode are light fills with dark text. It keeps the
  measured contrast without inventing a second accent per theme.
- Third-party doors on Home use the platform green rather than Stirling's or
  Grafana's brand colors.
- The guest share page says, plainly, that the file came from a private
  server and nothing was saved to the device. Friends of friends deserve to
  know what they clicked.
