# Printable document: layout reference

Supporting detail for `reference_how_to_make_a_printable_document.md` in the brain folder. Sections copied from the original skill, headings kept.

## Page dimensions

| Format | Dimensions | Usable after padding | Typical content budget |
|---|---|---|---|
| A4 portrait | 210mm x 297mm | 174mm x 259mm (with 18mm/22mm padding) | ~245mm vertical before footer |

## Canonical CSS block

Copy verbatim into the HTML `<style>`:

```css
@page { size: A4; margin: 0 }
* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box }

@media screen {
  html, body { padding: 20px 0; background: #E2E8F0; margin: 0 }
  .page { margin: 16px auto; box-shadow: 0 8px 32px rgba(15,23,42,0.18); border-radius: 4px }
}

@media print {
  html, body { background: #fff !important; width: 210mm; overflow: visible !important; margin: 0; padding: 0 }
  .no-print { display: none !important }
  section.page {
    width: 210mm !important;
    height: 297mm !important;
    min-height: 297mm !important;
    max-height: 297mm !important;
    padding: 18mm 18mm 22mm 18mm !important;
    margin: 0 !important;
    overflow: hidden !important;
    page-break-after: always;
    break-after: page;
    position: relative;
    display: flex;
    flex-direction: column;
    box-shadow: none !important;
  }
  section.page:last-of-type { page-break-after: avoid; break-after: avoid }
  section.page.cover { padding: 28mm 22mm !important }
  .phase, .callout, .ask-card, .stat, .ba-col, .section-header { page-break-inside: avoid; break-inside: avoid }
  h1, h2, h3, h4 { page-break-after: avoid; break-after: avoid }
}

section.page {
  width: 210mm;
  min-height: 297mm;
  padding: 18mm 18mm 22mm 18mm;
  background: #FFFFFF;
  position: relative;
  display: flex;
  flex-direction: column;
}
section.page .content-fill { flex: 1 1 auto }
section.page .page-number,
section.page .page-footer-label {
  position: absolute;
  bottom: 10mm;
  font-size: 8pt;
  letter-spacing: 0.08em;
  font-weight: 500;
}
section.page .page-number { right: 18mm }
section.page .page-footer-label { left: 18mm; text-transform: uppercase }
```

## HTML structure

```html
<body>
  <!-- Print-setting reminder (hidden when printing) -->
  <div class="no-print" style="text-align:center;padding:12pt 16pt;background:#fef3c7;max-width:210mm;margin:0 auto 16pt;border-radius:4pt;border:2pt solid #f59e0b;font-size:11pt">
    Chrome Ctrl+P. Paper: A4. Layout: Portrait. Margins: None. Background graphics: ON.
  </div>

  <!-- Page 1, COVER -->
  <section class="page cover">
    <!-- dark gradient cover per your theme -->
  </section>

  <!-- Pages 2+, CONTENT -->
  <section class="page">
    <div class="content-fill">
      <!-- all content goes here -->
    </div>
    <div class="page-footer-label">DOC, footer label</div>
    <div class="page-number">Page 02 / 08</div>
  </section>
</body>
```

## Theme tokens (swap these per document)

Define these as CSS custom properties at `:root`. Change them to re-theme without touching layout:

```css
:root {
  --ink-900:    #0B1120;   /* primary text */
  --ink-700:    #1F2937;   /* body emphasis */
  --ink-500:    #475569;   /* secondary text */
  --ink-300:    #94A3B8;   /* muted text (page numbers, captions) */
  --line:       #E2E8F0;   /* rules, borders */
  --bg:         #F8FAFC;   /* code background, soft panels */
  --surface:    #FFFFFF;   /* page + card backgrounds */
  --accent:     #1D4ED8;   /* primary brand color */
  --accent-soft:#EEF2FF;   /* accent tint for callouts */
  --amber:      #B45309;   /* warn */
  --amber-soft: #FEF3C7;   /* warn background */
  --green:      #047857;   /* success */
  --green-soft: #D1FAE5;   /* success background */
  --red:        #B91C1C;   /* danger */
  --red-soft:   #FEF2F2;   /* danger background */
  --gold:       #F59E0B;   /* brand accent (dots, underlines) */
}
```

To re-theme: change only `--accent`, `--gold`, and the cover gradient. Everything else stays.

## Fonts

Use Google Fonts preconnect plus a serif-for-headings and sans-for-body pair:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Fraunces:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Defaults that look professional:
- Headings: Fraunces 600 (or Playfair Display, or EB Garamond). Not Inter.
- Body: Inter 400-600 (or Source Sans Pro, or Open Sans).
- Code: SF Mono, Consolas, or Menlo.

## Cover page pattern

```html
<section class="page cover">
  <div class="brandmark">
    <span class="dot"></span>
    YOUR BRAND
  </div>
  <div class="kicker">Document subtype, audience, classification</div>
  <h1>One-line title,<br>two at most.</h1>
  <p class="intro">One short paragraph that frames the document. Two to four sentences.</p>
  <div class="divider"></div>
  <div class="meta">
    <div>From<strong>Author name, role</strong></div>
    <div>To<strong>Recipient name, role</strong></div>
    <div>Date<strong>24 April 2026</strong></div>
  </div>
  <span class="example-tag">Reading time, <b>approximately 10 minutes</b></span>
  <div class="cover-footer">
    <span>Internal, confidential</span>
    <span>Page 01 / 08</span>
  </div>
</section>
```

See `template.html` in this folder for the complete cover CSS (dark gradient, gold dot on brandmark, meta grid).

## Layout primitives worth using

All provided in `template.html`:
- `.section-header`: big section index (01, 02...) plus h2 and bottom rule
- `.doc-to-from`: gold-bar left border plus key/value pairs (for memo metadata)
- `.ba-table`: before/after 2-column comparison (red-soft vs green-soft)
- `.stat-grid`: 4-up numeric stat row
- `.callout.info` / `.callout.warn` / `.callout.success` / `.callout.danger`: colored side-border callouts
- `.ask-grid`: 3-up ask/decision cards with gold numerals
- `.timeline-table`: Step 1 / Step 2 / Step 3 table with accent labels
- `.clean-list`: bullet list with colored dot bullets
- `.phase`: numbered card with header (title plus time), body, optional save-box footer
- `.save-box`: dashed green box for "save this output" callouts
- `.settings-table`: compact label/value table
- `.sig-block`: 2-up signature lines at end of doc

## Verification workflow

After writing the HTML, verify it prints correctly:

```bash
# 1. Render with headless Chrome
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"   # Windows
# CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   # macOS
# CHROME="google-chrome"   # Linux

"$CHROME" --headless=new --disable-gpu --no-sandbox \
  --virtual-time-budget=20000 \
  --run-all-compositor-stages-before-draw \
  --print-to-pdf-no-header \
  --print-to-pdf="out.pdf" \
  "file:///absolute/path/to/doc.html"

# 2. Check page count + dimensions (expect all pages at 595x842 pt)
python -c "
from pypdf import PdfReader
r = PdfReader('out.pdf')
print(f'Pages: {len(r.pages)}')
for i, p in enumerate(r.pages):
    b = p.mediabox
    print(f'  Page {i+1}: {float(b.width):.1f} x {float(b.height):.1f} pt')
"

# 3. Rasterize each page to PNG + eyeball for overflow
python -c "
import pymupdf, os
doc = pymupdf.open('out.pdf')
os.makedirs('.tmp/pages', exist_ok=True)
for i, page in enumerate(doc):
    page.get_pixmap(dpi=110).save(f'.tmp/pages/page{i+1}.png')
"
```

Expected: every page exactly 595.0 x 841.9 pt (A4). Rasterized PNGs show no content extending past the footer and no cards split across pages.
