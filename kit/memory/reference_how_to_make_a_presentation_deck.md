---
name: How to make a presentation deck that prints to PDF
description: Slides, deck, pitch, presentation for a meeting or investors: how to build one that prints cleanly to PDF (A4 landscape HTML, one idea per slide, the template in kit/files). Read before making any slides.
type: reference
metadata:
  type: reference
  asserted: 2026-09-26
  updated: 2026-09-26
---

# How to make a presentation deck that prints to PDF

Chrome's print dialog only renders standard paper sizes: A4, A3, Letter, Legal. A deck built with a custom page size such as 13.333 by 7.5 inches forces the reader to find a "custom size" option that many print dialogs never expose. The reliable approach is to size every slide to A4 landscape, or Letter landscape only for a North American audience, and design the content to that exact canvas from the start rather than shrinking a 16:9 layout into it afterward.

A4 landscape is 297 by 210mm, aspect ratio about 1.41, and reads well for a global audience. Letter landscape is 11 by 8.5 inches, ratio about 1.29, squarer, and is the right call only when the audience is specifically North American.

## What good looks like

- One hero statement per slide. Dense material goes into a 2x2 or column card grid, not paragraphs.
- Left aligned body text. Center only titles, hero statements, or pull quotes.
- One repeated brand element on every slide, such as a corner wordmark with a colored dot, so the deck has identity without a logo on every page.
- A real palette: one content-informed primary color, never the default blue, plus one accent, at least three tones in total.
- Consistent spacing held throughout the deck. Pick one padding value and one gap size, then keep them.
- No accent line under titles. This is the clearest tell of a templated, AI-made deck. Whitespace does the same job better.
- A body sans paired with a serif or display face for headings, loaded through a font preconnect.

The full CSS block, the HTML skeleton, and a ready starter template with a cover slide, a two-column content slide, and a closing slide live at kit/files/presentation-deck/template.html in the brain folder. Copy it, swap the copy, keep the structure.

## Mistakes that show up over and over

- A custom page size instead of A4 or Letter landscape: the print dialog cannot express it.
- Missing the print color adjust property: backgrounds, card fills, and gradients print white without it.
- Forgetting to tell the reader to turn on background graphics in the print dialog.
- Mixing millimeters and inches in the same file. Pick one unit system per document.
- An accent line under every title, or centered body paragraphs: both read as templated.
- Content designed for 16:9 crammed into A4, whose ratio is 1.41, not 1.78. Redesign the grid rather than shrinking the layout.
- A slide section missing a page break rule, so Chrome concatenates every slide onto a single page.

When about to write a custom page size, add a title underline, center a paragraph, or write a slide as if it were a live talk, stop and use the alternative above instead.

## What to tell the reader before they export

Open the HTML in Chrome, then File, Print. Paper A4 (or Letter). Layout Landscape. Margins None. Background graphics on. Save as PDF.

## When this approach is not the right one

- A live presentation with animations, transitions, or speaker notes needs a real presentation tool, not static HTML.
- An editable slide file needs a library that writes that file format directly.
- A single page memo or letter does not need any of this; see [[reference_how_to_make_a_printable_document]].
- Pixel-exact print work, such as physical media at true size, needs a dedicated print CSS library used directly.

## Related
[[reference_how_to_make_a_printable_document]] [[reference_how_to_write_a_document]]
