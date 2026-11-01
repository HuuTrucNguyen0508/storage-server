# storage-server, visual direction

The product is one person's disk behind a login, and the loop is: get a file in, find it, send a link. The design treats the app as a place you are standing in rather than a dashboard you look at. The current folder's name is the one loud element on every owner screen, set large and tight at the top with its path above it in a quiet line. Everything else is a disciplined list: no cards, no grid, no decorative gradients. The palette comes from the physical objects behind the metaphor, manila folders and the teal cloth of archive boxes, on a cool off-white board. Guests get the same headline treatment for the thing they were sent, and nothing else from the owner's chrome. Links are rows with a plainly worded state, not badges.

Files in this directory:

| File | What it is |
|---|---|
| `tokens.css` | Custom properties for light and dark. Production imports it unchanged. |
| `browser.html` | Owner's browser, folder open, three selected, three uploads in flight. Responsive. |
| `browser-phone.html` | Same screen at 390 px with the phone chrome (tab bar, two-line rows, bottom action bar). |
| `browser-drop.html` | The browser while files are dragged over it. |
| `share.html` | Creating a link and the list of links. |
| `guest.html` | Guest page for a shared folder, and the password prompt. |
| `guest-preview.html` | The preview overlay, opened from the guest page. |
| `drop.html` | Guest upload page for a drop link, before and during sending. |
| `empty-states.html` | Empty folder, empty trash, broken link. |
| `contrast.py`, `contrast.txt` | The contrast script and its output. |
| `build.py`, `shoot.sh` | Regenerate the HTML and the screenshots. |
| `shots/` | Headless Chromium screenshots of every page, light and dark. |

Every page accepts `?theme=dark` or `?theme=light`. Without it the page follows the OS setting.

## What it is grounded in

- The disk is the source of truth, so the interface shows paths, names, sizes and dates, and nothing the disk does not know. No stars, no "recent", no tags.
- The owner is one person on a laptop and an Android phone. Both get the same page, not a mobile app imitation. The phone layout is the desktop layout with the rail folded into a tab bar.
- A guest arrives with one URL and no context. The guest page says what they were sent, who sent it (the server's host name), what will happen to the link, and gives one primary action.
- The folder icon is a filled manila shape, the only coloured icon in the set. Files are line icons. That one difference makes a folder findable at a glance in a long list, which matters more than a pretty icon set.

## Colour

Light is the default. Dark follows `prefers-color-scheme` unless `data-theme` is set on `<html>`.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#EEF0EC` | `#141817` | Canvas. Cool grey-green board, not cream. |
| `--surface` | `#FFFFFF` | `#1D2221` | Lists, sheets, inputs. |
| `--surface-2` | `#E4E7E1` | `#272D2B` | Hover, pressed, alternate. |
| `--line` | `#D3D7D0` | `#333A38` | Hairlines between rows. |
| `--line-strong` | `#8D948F` | `#6E7873` | Input and button borders (3:1 floor). |
| `--ink` | `#1B201E` | `#E7EAE6` | Primary text. |
| `--ink-2` | `#566059` | `#A4ADA7` | Secondary text: sizes, dates, hints. |
| `--ink-3` | `#7F8882` | `#78827C` | Disabled text, ghost rows, inactive glyphs. |
| `--accent` | `#0F6462` | `#5FCBC2` | Archive teal. Links, primary buttons, focus ring, progress. |
| `--accent-ink` | `#FFFFFF` | `#0B1F1E` | Text on the accent fill. |
| `--accent-tint` | `#D6E9E6` | `#1F3B39` | Selected rows, drop zones, pressed filters. |
| `--accent-hover` | `#0B5250` | `#83D9D1` | Primary button hover. |
| `--folder` | `#D7B463` | `#D4B066` | Manila folder fill. Decorative. |
| `--folder-edge` | `#A5842F` | `#8C6F2B` | Folder outline, carries the 3:1 for the icon. |
| `--ok` | `#24704A` | `#72CB93` | Live link, sent file. |
| `--warn` | `#8A5A00` | `#E6B14A` | Expiring, download limit nearly used, paused upload. |
| `--danger` | `#A82E1F` | `#F2908A` | Revoke, errors. |
| `--danger-ink` | `#FFFFFF` | `#2A0B08` | Text on a danger fill. |
| `--scrim` | `rgba(27,32,30,.62)` | `rgba(0,0,0,.7)` | Behind the preview overlay. |

Inverted surfaces (the selection bar, toasts, the drop label) use `--ink` as background and `--bg` as text, so they pass by the same numbers as body text.

## Type

Two families, both SIL Open Font License, both bundled under `/fonts/` as woff2 so the server loads nothing from the internet:

- **Fira Sans** (Mozilla, OFL 1.1), weights 400, 500, 600. All interface text. Tabular figures on (`"tnum"`) everywhere so sizes and dates line up in columns.
- **JetBrains Mono** (JetBrains, OFL 1.1), weight 400. Only for strings a person copies character by character: the share URL, the link id on the broken-link page, the first-run setup code. Nothing else is monospace.

The `@font-face` rules in the mockups try `local()` first, then the bundled woff2. Both families are installed on this machine, so the screenshots show the real faces.

Scale, 15 px base, roughly a 1.2 ratio with the display sizes stretched:

| Token | Size | Used for |
|---|---|---|
| `--text-xs` | 13 px | Metadata, captions, hints, tray lines |
| `--text-sm` | 14 px | Dense cells, breadcrumbs, segmented controls |
| `--text-md` | 15 px | Body, rows, buttons |
| `--text-lg` | 18 px | Sheet titles |
| `--text-xl` | 22 px | Empty-state titles, folder name on the narrowest layouts |
| `--text-2xl` | 28 px | Folder name on phone, guest title on phone |
| `--text-3xl` | 36 px | Folder name on desktop |
| `--text-4xl` | 44 px | Guest page title on desktop |

Display sizes are weight 600 with `-0.02em` tracking and 1.1 line height. Body is 1.35 in lists and 1.5 in paragraphs. Line length is capped at `--measure: 64ch`. Labels are sentence case; there is no all-caps anywhere.

## Layout

Desktop owner screen, left aligned throughout:

```
┌──────────┬────────────────────────────────────────────────────────┐
│ ▣ storage│ [🔍 Search by name, press / to focus          /]   👤  │
│          ├────────────────────────────────────────────────────────┤
│ Files    │ content › photos › 2026 ›                              │
│ Links 12 │ iceland                             [+ New folder][⇧ Upload]
│ Trash  3 │ 13 items, 16.8 GB                                      │
│          │ ┌──────────────────────────────────────────────────┐   │
│          │ │ ☐  Name                  Modified          Size  │   │
│          │ │ ☐ ▭ raw                  Yesterday 22:14  41 items   │
│          │ │ ☑ ▦ DSC_0402.jpg         Yesterday 21:40  12.3 MB│   │
│ ──────── │ │ …                                                │   │
│ Uploading│ │ ░ DSC_0413.ARW  Uploading, 31.2 MB of 48.9 MB    │   │
│ 3 of 7   │ └──────────────────────────────────────────────────┘   │
│ ▓▓▓▓░░   │         ( 3 selected  ⇩ Download zip  ⛓ Share  ⇨ Move  🗑 Trash  × )
└──────────┴────────────────────────────────────────────────────────┘
```

- The rail holds three destinations and the uploads tray. The tray lives in the rail, not in a corner toast, so a 4 GB upload stays visible while the owner keeps browsing.
- The path is two lines: parents in a small quiet line, the current folder as the headline. The headline is the hero of every owner page and the only large type on it.
- The list is one surface with hairlines between rows. Columns: select, name, modified, size, more. Sizes and dates are secondary ink and right aligned.
- A selection summons a floating bar at the bottom centre. It names the count and the four verbs. It never covers the headline.
- In-progress uploads appear as ghost rows at the bottom of the destination folder, with a thin progress line, so the owner sees where a file is landing.

Phone, 390 px:

```
┌──────────────────────────────┐
│ [🔍 Search by name     ]  👤 │
│ ‹ 2026                       │
│ iceland          [+][⇧ Upload]│
│ 13 items, 16.8 GB            │
│ [⇧ ▓▓▓▓░░░ 3 of 7, 61%    ›] │
│ ┌──────────────────────────┐ │
│ │ ☐ ▭ raw                ⋯ │ │
│ │     41 items, Yesterday  │ │
│ │ ☑ ▦ DSC_0402.jpg       ⋯ │ │
│ │     12.3 MB, Yesterday   │ │
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ 3 selected  ⇩  ⛓  ⇨  🗑  × │ │  ← replaces the tab bar while selecting
└──────────────────────────────┘
```

- Rows become two lines, 56 px tall. The checkbox target is the full 44 by 56 px cell.
- The uploads tray collapses to one line under the headline; tapping it opens the full list.
- The tab bar (Files, Links, Trash) sits at the bottom. The selection bar replaces it while anything is selected.

Guest pages are a single centred column, 760 px max, left aligned inside. The host name is the only header. The title is the item name at display size. One primary action, then the list. The password prompt is the same page with a single sheet instead of the list.

Drop pages put the drop target where the list would be, since the guest cannot see the list. After the first file is chosen the target shrinks to a strip with "Add more files" and the list of files they sent takes the space.

## The one bold element

The folder name as a headline. Everything else is set to recede so that it reads first. The accent is used for actions and state, never for decoration. No gradients, no illustration, no shadow on rows. Sheets and the selection bar get a shadow because they float.

## Motion

- Motion only answers an action. Nothing moves on page load.
- Durations: `--dur-fast` 120 ms for hover and drop ring, `--dur-base` 180 ms for the selection bar rising and the preview overlay fading in, `--dur-slow` 260 ms for sheets on phone. Easing is `--ease-out` for things appearing, `--ease-in` for things leaving.
- Progress bars change width through a linear transition. The in-flight segment of an upload bar carries moving stripes so the owner can tell "transferring" from "stalled" without reading text.
- Under `prefers-reduced-motion: reduce` every duration token becomes 0 ms and the stripes stop. State is always also expressed in words, so nothing is lost.
- Rows change background instantly on hover and selection. No row scales, slides or lifts.

## Interactions

**Drag and drop anywhere.** On `dragenter` with files, the whole browser page gets an inset 2 px accent ring with a label naming the destination, "Drop to upload into iceland". Hovering a folder row while dragging highlights that row with the same ring and the label changes to that folder's name. Dropping on a breadcrumb uploads into that ancestor. Dropping on the rail's Trash is not supported; trash is a verb on selected items only. Dragging rows already in the list onto a folder row or a breadcrumb moves them; the ring colour is the same, the label says "Move 3 items into raw". Dropped folders upload with their structure. The ring is `pointer-events: none` so the drop lands on the page.

**Multi-select on touch.** A long press of 500 ms on a row enters selection mode and selects that row. In selection mode a tap toggles a row, checkboxes are always visible, "Select all" appears in the headline's action slot, and the selection bar replaces the tab bar. Tapping the × in the bar or the system back gesture leaves selection mode. On desktop a click on the checkbox selects without opening, a click on the name opens, Shift-click extends the range, Ctrl-click toggles.

**Keyboard.** `/` focuses search. Up and Down move the focused row, Home and End jump, Space toggles selection, Shift plus arrow extends it, Enter opens, Backspace or Alt-Left goes to the parent folder, Ctrl-A selects all, Delete trashes the selection and shows an undo toast for 8 seconds, F2 renames in place, Ctrl-C copies the share link of a single selected item if it has one, Escape clears the selection, then closes any sheet, then closes the preview. Every interactive element shows the focus ring: 2 px of surface then 2 px of accent, so it is visible on both the canvas and selected rows. Rows are focusable (`tabindex="0"`), and the first Tab into the list lands on the first row, not on each checkbox.

**Preview overlay.** Opening any image, video, audio, PDF, text or Markdown file covers the viewport with the scrim and a frame. The top bar has close, the file name with size, dimensions or duration and the position in the folder, and Download; the owner also gets Share. Left and Right arrows, or swiping on a phone, move through the previewable files of the same folder in list order. Images pinch zoom on touch and scroll zoom on desktop; double tap toggles 1:1. Video and audio use the native controls and seek via Range requests. PDF, HTML-ish text and Markdown render inside a sandboxed `<iframe>` served from the raw-file origin or with a CSP that forbids script, so an uploaded HTML or SVG file never runs in the app's origin. Escape and the scrim close. Focus is trapped inside the overlay while it is open and returns to the row afterwards.

**Resumed upload.** Each upload in the tray is a name, a status line and a bar. The bar has two segments: solid accent for bytes the server has confirmed stored, striped accent for bytes in flight. If the connection drops, the status turns to the warn colour, "Paused at 1.2 GB of 4.6 GB, reconnecting", the stripes stop and the stored segment turns grey. The client retries from the server's reported offset and the bar continues from the solid segment, never from zero. After a page reload the tray is rebuilt from local storage, but a browser cannot re-read a file it was not handed again, so those items show "Pick the file again to continue from 710 MB" with a Pick button. Choosing the same file resumes from the server offset; choosing a different file starts a new upload and says so. The destination folder shows a ghost row for every item in the tray until it completes, at which point the ghost becomes a real row with no animation beyond the colour change.

**Share flow.** Share from the selection bar or a row's menu opens the New link sheet. The link exists the moment the sheet opens, so the URL and Copy button are usable immediately; options change it in place. Password, expiry (1 day, 7 days, 30 days, never, or a date), download limit, and for folders a switch that turns the link into a drop link. Save link closes the sheet and shows "Link copied" with an Open action. The Links page lists every link with its state in plain words: "Live, expires in 6 days, 14 downloads". Copy and Revoke sit on every row; Revoke asks once, then the row moves to Ended.

**Guest.** A guest sees the host name, the item name, what is in it and when the link stops working, and a Download all button that names the zip's size. Rows open the preview; the download glyph on each row downloads that file. The password page is the same frame with one field and Open; a wrong password keeps the page and says "That password is not right" under the field without clearing it. A link that is expired, revoked, past its limit or whose file is in the trash gets the same broken-link page with the three possible causes and the one thing the guest can do.

**Empty states.** Each says what the screen is, what will happen here, and offers the first action. The empty folder repeats the drop-anywhere promise. The empty trash explains the 30-day rule and that restore re-enables links, which is the one rule the owner must know.

## Quality floor, measured

- Focus: `:focus-visible` draws `--focus-ring` on every control, row and tab. The ring is two colours so it is visible on white, on the canvas and on a selected row.
- Reduced motion: the duration tokens are zeroed in a media query inside `tokens.css`, and the striped bar and the selection bar's rise are also switched off explicitly.
- Touch targets: on phone every row is 56 px, every button is 44 px (`--control-h-phone`), the checkbox cell is 44 by 56 px, the tab bar items are 56 px, switches are 44 px tall including their label.
- Contrast: every text and background pair in the tokens, plus the non-text pairs that WCAG 1.4.11 covers, measured with `contrast.py` using the WCAG 2.x relative luminance formula. Command and output:

```
$ python3 -I contrast.py tokens.css

light
pair                               fg       bg        ratio  need  result   use
ink on bg                          #1B201E  #EEF0EC   14.40  4.5   pass     primary text on canvas
ink on surface                     #1B201E  #FFFFFF   16.51  4.5   pass     primary text on surface
ink on surface-2                   #1B201E  #E4E7E1   13.22  4.5   pass     primary text on hover / alt surface
ink on accent-tint                 #1B201E  #D6E9E6   13.10  4.5   pass     primary text on selected row
ink-2 on bg                        #566059  #EEF0EC    5.70  4.5   pass     secondary text on canvas
ink-2 on surface                   #566059  #FFFFFF    6.54  4.5   pass     secondary text on surface
ink-2 on surface-2                 #566059  #E4E7E1    5.23  4.5   pass     secondary text on hover / alt surface
ink-2 on accent-tint               #566059  #D6E9E6    5.18  4.5   pass     secondary text on selected row
accent on bg                       #0F6462  #EEF0EC    6.06  4.5   pass     link / accent text on canvas
accent on surface                  #0F6462  #FFFFFF    6.95  4.5   pass     link / accent text on surface
accent on accent-tint              #0F6462  #D6E9E6    5.52  4.5   pass     accent text on selected row
accent-ink on accent               #FFFFFF  #0F6462    6.95  4.5   pass     button label on accent fill
ok on surface                      #24704A  #FFFFFF    6.01  4.5   pass     live / success text
ok on bg                           #24704A  #EEF0EC    5.24  4.5   pass     live / success text on canvas
warn on surface                    #8A5A00  #FFFFFF    5.93  4.5   pass     expiring / warning text
warn on bg                         #8A5A00  #EEF0EC    5.17  4.5   pass     expiring / warning text on canvas
danger on surface                  #A82E1F  #FFFFFF    6.83  4.5   pass     error / revoke text
danger on bg                       #A82E1F  #EEF0EC    5.95  4.5   pass     error / revoke text on canvas
danger-ink on danger               #FFFFFF  #A82E1F    6.83  4.5   pass     label on danger fill
line on surface                    #D3D7D0  #FFFFFF    1.46  1.0   pass     hairline (decorative, no requirement)
line-strong on surface             #8D948F  #FFFFFF    3.10  3.0   pass     input border / focus-adjacent border
accent on surface                  #0F6462  #FFFFFF    6.95  3.0   pass     focus ring on surface
accent on bg                       #0F6462  #EEF0EC    6.06  3.0   pass     focus ring on canvas
folder-edge on surface             #A5842F  #FFFFFF    3.53  3.0   pass     folder icon outline on surface (fill is decorative)
folder-edge on bg                  #A5842F  #EEF0EC    3.08  3.0   pass     folder icon outline on canvas
ink-3 on surface                   #7F8882  #FFFFFF    3.65  3.0   pass     disabled text / icon glyph (non-text floor)

dark
pair                               fg       bg        ratio  need  result   use
ink on bg                          #E7EAE6  #141817   14.76  4.5   pass     primary text on canvas
ink on surface                     #E7EAE6  #1D2221   13.28  4.5   pass     primary text on surface
ink on surface-2                   #E7EAE6  #272D2B   11.57  4.5   pass     primary text on hover / alt surface
ink on accent-tint                 #E7EAE6  #1F3B39    9.93  4.5   pass     primary text on selected row
ink-2 on bg                        #A4ADA7  #141817    7.77  4.5   pass     secondary text on canvas
ink-2 on surface                   #A4ADA7  #1D2221    6.99  4.5   pass     secondary text on surface
ink-2 on surface-2                 #A4ADA7  #272D2B    6.09  4.5   pass     secondary text on hover / alt surface
ink-2 on accent-tint               #A4ADA7  #1F3B39    5.23  4.5   pass     secondary text on selected row
accent on bg                       #5FCBC2  #141817    9.22  4.5   pass     link / accent text on canvas
accent on surface                  #5FCBC2  #1D2221    8.29  4.5   pass     link / accent text on surface
accent on accent-tint              #5FCBC2  #1F3B39    6.20  4.5   pass     accent text on selected row
accent-ink on accent               #0B1F1E  #5FCBC2    8.79  4.5   pass     button label on accent fill
ok on surface                      #72CB93  #1D2221    8.20  4.5   pass     live / success text
ok on bg                           #72CB93  #141817    9.11  4.5   pass     live / success text on canvas
warn on surface                    #E6B14A  #1D2221    8.25  4.5   pass     expiring / warning text
warn on bg                         #E6B14A  #141817    9.17  4.5   pass     expiring / warning text on canvas
danger on surface                  #F2908A  #1D2221    7.01  4.5   pass     error / revoke text
danger on bg                       #F2908A  #141817    7.79  4.5   pass     error / revoke text on canvas
danger-ink on danger               #2A0B08  #F2908A    7.94  4.5   pass     label on danger fill
line on surface                    #333A38  #1D2221    1.38  1.0   pass     hairline (decorative, no requirement)
line-strong on surface             #6E7873  #1D2221    3.53  3.0   pass     input border / focus-adjacent border
accent on surface                  #5FCBC2  #1D2221    8.29  3.0   pass     focus ring on surface
accent on bg                       #5FCBC2  #141817    9.22  3.0   pass     focus ring on canvas
folder-edge on surface             #8C6F2B  #1D2221    3.40  3.0   pass     folder icon outline on surface (fill is decorative)
folder-edge on bg                  #8C6F2B  #141817    3.77  3.0   pass     folder icon outline on canvas
ink-3 on surface                   #78827C  #1D2221    4.05  3.0   pass     disabled text / icon glyph (non-text floor)

0 failing pair(s)
```

Two pairs are deliberately not held to 4.5:1. `--line` is a hairline with no requirement. `--ink-3` is used only for disabled text and ghost rows, which WCAG exempts, and it still clears the 3:1 non-text floor. No text is ever set on the folder fill; the folder outline is what carries the icon's contrast, and the first run of the script showed the fill alone at 1.98:1 on white, which is why the outline exists.

## Review against the brief, and what changed

I wrote the first plan, then asked what I would have produced for "a self-hosted file browser" with no brief at all, and compared.

- **Palette.** The first draft had a warm cream canvas near `#F4F1EA`. That is the current generated default and says nothing about this product. Replaced with a cool grey-green board (`#EEF0EC`) that reads as archival stock. The accent was briefly blue, which is every file service's colour; replaced with archive teal, which sits next to the manila folder rather than fighting it.
- **Metadata strings.** The first draft wrote "48 items · 12.4 GB" with middle dots and set sizes in monospace. Both are template tells. Now commas separate facts ("13 items, 16.8 GB") and the only monospace is the URL a person copies.
- **Column headers and labels.** The first draft used small caps headers. Now sentence case at 13 px, secondary ink.
- **Uploads.** The default is a bottom-right toast. Because a 4 GB upload on a home connection is a ten-minute event the owner wants to keep an eye on, the tray lives in the rail where it can hold three states at once (transferring, paused, waiting for the file to be picked again).
- **Drop zone.** The dashed border is the reflex. Replaced with a solid inset ring and a label that names the destination, since the destination is the question a person has while dragging.
- **Links.** The first draft showed each link as a card with a coloured pill badge. Cards hide the fact that this is a list of nine strings. Now a two-line row: name, then the state as a sentence with the state word coloured. It also survives the phone width without a second layout.
- **Folder name as hero.** Kept. It is the one choice that is specific to this brief: the owner's disk has folders with names they chose, and the name is the most meaningful word on the screen.
- **Guest page.** The first draft put a download button per row and a big centred title. Centred text for a list page is a landing-page reflex; the guest page is now left aligned like the owner page, so a guest who later becomes an owner meets the same shape.

Found in screenshot review and fixed before delivery: the links list overlapped itself at the two-column width, the account glyph read as a sun, long names could escape the name column on desktop, and the phone tab bar leaked onto desktop.

## Self-critique

What I removed before finishing: a QR code in the share sheet (useful for handing a link from laptop to phone, but the owner has the tailnet for that and the sheet was getting a fourth thing to look at), a thumbnail grid view (the brief's loop is find-and-send, and a list with 32 px thumbnails finds faster than a grid), a per-row hover reveal of the share action (it hid the most important verb; it now lives in the selection bar and the row menu), and a coloured left rule on link rows to encode state (the words already do it).

What I am least sure of: the `.ARW` raw photo as the in-flight upload example has no thumbnail, which is honest but makes the ghost row look different from its siblings. And the folder fill at `#D7B463` is the one colour in the light palette that does not pass 3:1 on white; the outline covers the requirement, but a stricter reading would want a darker fill, which would lose the manila.

## Notes for production

- Bundle `FiraSans-Regular`, `FiraSans-Medium`, `FiraSans-SemiBold` and `JetBrainsMono-Regular` as woff2 under `/fonts/`, with the `@font-face` rules from the mockups. No other external asset of any kind.
- Icons are inline SVG, 20 px, 1.6 px stroke, round caps. The folder is the only filled icon. Keep it that way.
- Previews of untrusted content (HTML, SVG, Markdown rendered to HTML, PDF) must render in a sandboxed frame on a separate origin or under a CSP with no script, as the brief requires.
- The `?theme=` query parameter is mockup chrome. Production should use `data-theme` driven by a setting, with the OS as the default.
- The `.mock-note` strip at the top of each page and the dashed dividers between side-by-side states are mockup chrome, not product.
