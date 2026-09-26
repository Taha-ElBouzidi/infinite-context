---
name: How to make a printable document that exports cleanly to PDF
description: PDF report, printable document, A4 memo, proposal or brief to print or send: how to lay it out so it prints without clipping (fixed A4 pages, the template and layout rules in kit/files). Read before producing a printable file.
type: reference
metadata:
  type: reference
  asserted: 2026-09-26
  updated: 2026-09-26
---

# How to make a printable document that exports cleanly to PDF

This fits a memo, proposal, report, brief, or runbook of roughly 2 to 20 pages that will be shared as a PDF and needs to survive a non-technical reader hitting Ctrl+P in Chrome with default settings and still looking right. A slide deck (landscape, one idea per page) is a different shape; see [[reference_how_to_make_a_presentation_deck]].

The core insight: Chrome's A4 print CSS only prints reliably when each page is a fixed-height container with overflow hidden, and the content inside that container is hand-sized to fit. Letting content flow naturally and trusting Chrome to paginate it produces widow lines, orphaned headers, and tables cut off mid-row. The pattern proven across many documents is: each page is a fixed 210mm by 297mm section, a flex wrapper inside pushes the footer to the bottom, the footer is absolute-positioned near the bottom edge, print CSS forces the fixed height plus a page break after every page, and the content is sized by hand to roughly 245mm of usable vertical space per page. If a page overflows, split it into a new page or trim the content; do not rely on automatic pagination to fix it.

A4 portrait usable space, after 18mm and 22mm padding, is about 174mm by 259mm, with roughly 245mm of vertical budget before the footer.

## Where the reusable pieces live

The canonical CSS block, the HTML skeleton, the theme token list, the font choices, the cover page pattern, the named layout pieces (section headers, before/after tables, stat grids, callouts, phase cards, signature blocks, and more), and the verification workflow all live at kit/files/printable-document/layout.md in the brain folder, with a ready starter template at kit/files/printable-document/template.html. Copy the CSS in verbatim rather than rewriting it; it encodes a lot of trial and error about what actually prints.

The short version of verification: render the HTML with headless Chrome to a PDF, check that every page is exactly 595.0 by 841.9 points (A4), then rasterize each page to an image and look for content running past the footer or a card split across a page break.

## Mistakes that show up over and over

- Content spills past the footer and prints clipped: the page exceeds its vertical budget. Split to a new page or shrink fonts and padding; do not rely on Chrome to paginate.
- The footer floats mid-page instead of sitting at the bottom: the content wrapper that should flex to fill the page is missing.
- The cover page looks cramped: it needs its own, larger padding, not the padding shared with content pages.
- A card or block is split across two pages: it is missing a rule that keeps it from breaking inside.
- A heading is orphaned at the bottom of a page: it is missing a rule that keeps a break from landing right after it.
- Chrome adds margins even though the page CSS sets them to zero: the reader forgot to set Margins to None in the print dialog. A visible reminder banner on the page fixes this.
- Code blocks run past the right edge: they need a wrap rule that breaks long tokens.
- Theme colors print as white: the color adjust property is missing, or the reader never turned on background graphics.
- Fonts render wrong in the exported PDF: the headless render is missing a flag that waits for compositing to finish.
- A document designed as 4 pages renders as 6: some section is over its vertical budget; the rasterized check finds which one.

Before relying on flowing content and letting Chrome paginate it, before putting a large table on one page with no room to breathe, before centering body paragraphs, or before using a non-standard page size, stop and use the fixed-height, hand-sized, A4-standard pattern instead.

## What to tell the reader before they export

Open the document in Chrome, then Ctrl+P. Paper A4. Layout Portrait. Margins None (this is the setting people forget). Background graphics on. Save as PDF.

## When this approach is not the right one

- A landscape presentation or slide deck: use [[reference_how_to_make_a_presentation_deck]], which shares the same design token system and verification workflow with different page dimensions.
- A long-form book or manual that needs a table of contents and automatic numbering: a proper typesetting tool fits better than hand-sized HTML pages.
- A document that is only ever read on screen and never printed: plain CSS without any of this page-media handling is simpler.
- A file that must be an editable word-processor document: a library that writes that format directly is the right tool, not HTML.

## Related
[[reference_how_to_make_a_presentation_deck]] [[reference_how_to_write_a_document]]
