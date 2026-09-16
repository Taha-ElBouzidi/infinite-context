# Changelog

Infinite Context, infinite context for your AI model.

## 0.2.6

- Dashboard: the page is now a document taller than the viewport, not a fixed layer overdrawn past
  it. The 0.2.4 overdraw did nothing, because a fixed element is laid out against the viewport rect
  and clipped by it, and on iPadOS that rect is the number that is wrong. The body carries
  `min-height: calc(var(--app-h) + 160px)` and the ground is absolute inside it, so it paints in
  document coordinates the way an ordinary scrolling page does.
- Dashboard: `overflow: hidden` comes OFF the root, since the root's overflow propagates to that
  same broken viewport rect and clips the ground straight back. The page is genuinely scrollable
  and the scroll is locked in JavaScript instead, so it looks scrollable and never moves. Panels
  that scroll internally carry `overscroll-behavior: contain`, and the root hides its scrollbar.
- Dashboard: safe-area insets are now per element and per device class rather than one rule for the
  whole app. The detail panel gained `env(safe-area-inset-top)`, which it never had because it is
  `position: fixed` and body padding does not reach a fixed element. On a tablet the bottom controls
  no longer reserve `env(safe-area-inset-bottom)`. On a phone the icon bar has
  `clamp(12px, env(safe-area-inset-bottom), 34px)` for rounded corners and the home indicator, and
  everything that clears that bar grows by the same clamp.
- Dashboard: the detail panel title moved off the display serif, which was unreadable at 27px on a
  retina tablet.
- Dashboard: the 4K image export is removed, with the right click binding on the canvas and its
  rail row. The Names toggle stays.

## 0.2.5

- The publisher refuses a release whose version has no section in this file. 0.2.3 and 0.2.4 both
  shipped while this changelog still stopped at 0.2.2, because nothing checked.
- Backfilled the 0.2.3 and 0.2.4 entries.

## 0.2.4

- Dashboard: the page ground overdraws 120px past the bottom of the reported viewport. On iPadOS a
  standalone app can report a viewport shorter than the screen, and a layout made entirely of
  viewport-sized fixed elements then leaves an unpainted strip. A scrolling page never shows this,
  which is the tell: its background covers the whole content flow.

## 0.2.3

- Dashboard: the canvas takes its size from `window.visualViewport` rather than any CSS viewport
  unit. In a standalone app iPadOS miscalculates the bottom for viewport-sized fixed containers,
  and `100vh`, `100dvh` and `inset:0` all inherit the same wrong number.
- Dashboard: `overflow: hidden` on html and body, because that phantom gap is also scrollable.

## 0.2.2

- Dashboard: safe-area insets moved into the base layout. A 13 inch iPad in landscape is 1288pt
  wide, above the tablet breakpoint, so it landed on the desktop rules, which reserved nothing:
  the title printed under the status bar and the controls sat in the home indicator.
- Dashboard: the canvas is pinned to the viewport with `inset:0` instead of `100vh`, which is not
  the visual viewport on iPadOS and left a black strip along the bottom where the body showed
  through.

## 0.2.1

- `MINDMAP_NODES.md` now ships. `reflect.mjs` and `fix-mindmap-type.mjs` both cite it by name, and
  since the dashboard landed it is the document that says what becomes a node, so a reader who
  followed the citation previously found nothing.
- The exporter checks whether a file BELONGS here, not only whether it names anybody: absolute
  paths, code reaching above the repo root, and citations of documents the export does not
  contain. Three real problems had passed a clean identity scan.
- Removed an absolute path from `status.mjs` and `deep-test.mjs`: both printed or probed one
  machine's directory layout.

## 0.2.0

- **The dashboard.** `node tools/dashboard.mjs --open` draws your memories as a live picture: a node
  per memory, an edge per wikilink, and a current from the machine to the memory on every recall.
  Zero dependencies, no build step; it reads `memory/` directly so it works on a fresh clone.
- With an empty `memory/` it generates an example constellation rather than showing a black screen,
  labelled as an example and replaced by your own the moment you write a memory.
- Two layouts: Sphere groups by kind and bundles links through each band, Constellation positions
  by link structure, computed on the client with no embeddings required.
- Everything about the look is `dashboard/config.json`: name, tagline, regions and which memory
  types fall in each, the whole palette, your own links in the rail, machines on or off.
- Right click saves the view as a PNG with the long edge at 3840. Works on a phone, and can be
  added to a home screen.

## 0.1.2

- Documentation: docs/OPTIONS.md with a diagram per option, docs/BENCHMARKS.md with every measured number and its method, docs/GLOSSARY.md. Keyword-only against fused recall measured on the same corpus.

## 0.1.1

- Semantic recall on by default: `init.mjs` installs the runtime and builds vectors, the hook starts the embedder itself when it is down. `--no-semantic` to opt out.
- Branch model: `main` stable, `develop` for pull requests, releases as tags.

## 0.1.0

First release. Local-only mode.

- Pointer-based recall: five slugs and descriptions per prompt, the agent opens what it needs.
- Two retrieval channels, keyword and semantic, fused. Both on by default, both local. The hook starts the embedder itself.
- Behaviour rules are memories with a `rule:` line, injected every turn. Five generic seeds.
- `tools/init.mjs` sets up an empty brain in one command and verifies itself.
- `tools/install-hook.mjs` wires Claude Code, backs up settings first, never clobbers.
- `tools/verify.mjs` is the gate: parses every tool and hook, checks index sync and reflection.
- `tools/eval-recall.mjs`, `tools/bench-recall.mjs`, `tools/analytics.mjs` measure it.
- Windows tested. Engine is plain Node; scheduling helpers are Windows-only and optional.

Multi-machine mode exists and is used by the authors. It is not documented for outside use yet.
