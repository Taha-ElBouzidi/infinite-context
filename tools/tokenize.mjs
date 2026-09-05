// The tokenizer, shared by the indexer and the query side.
//
// It lives in one file because the two sides MUST agree. If build-index stems "logging" to
// "log" and the hook does not, the term is unreachable and nothing errors: retrieval just
// quietly gets worse, which is the failure mode this whole system keeps producing.
//
// Three fixes measured on 2026-08-10 against tools/eval-recall.mjs, each one my own bug:
//
// 1. MINIMUM LENGTH WAS 4, which silently deleted the most domain-specific terms the owner uses:
//    mcp, api, ui, ux, ai, pr, db, cv, hr, gym. "i want to be told before you change the ui"
//    could not match anything because "ui" did not exist in the index. Now 2, with a stopword
//    list doing the work instead of a blunt length rule.
//
// 2. NO STEMMING, so "writing" and "write" were different terms, as were "installed" and
//    "install", "projects" and "project". the owner types the inflected form and the descriptions
//    carry the base form, so they never met. This is deliberately crude suffix stripping, not
//    Porter: it needs to be identical on both sides and easy to reason about, and over-stemming
//    costs far less here than under-stemming.
//
// 3. TERMS IN MORE THAN 8 MEMORIES WERE DROPPED ENTIRELY, taking out day, food, raw, money,
//    owed and project. That is not how IDF works: a common term should weigh little, not
//    vanish. Dropping it removes the ability for several weak signals to add up, which is
//    exactly how "when does the day start for logging" should have found the day-cutoff rule.
//    Weighting now happens purely at query time via 1/df.

const STOP = new Set((
  'the a an and or but if then than that this these those of in on at to for with from by as is '
  + 'are was were be been being it its his her their our your my me you he she they we i do does '
  + 'did done have has had will would can could should shall may might must not no yes so such '
  + 'about into over under out up down off again once here there when where why how all any both '
  + 'each few more most other some only own same too very just also now new old get got make made '
  + 'use used using need needs want wants like likes see saw know known think thought take took go '
  + 'going come came what which who whom whose while during before after above below between '
  + 'through against because until unless upon per via etc am pm ok okay yeah yes dont doesnt isnt '
  + 'wasnt cant wont im ive id ill youre theyre thats whats lets us them him one two three'
).split(/\s+/));

// Order matters: longer suffixes first, so "ingly" does not become "ing" then "in".
function stem(w) {
  if (w.length <= 3) return w;
  for (const [suf, min] of [['ations', 6], ['ation', 5], ['ings', 5], ['edly', 5], ['ing', 4],
    ['ies', 4], ['ied', 4], ['ers', 4], ['er', 4], ['ed', 4], ['ly', 4], ['es', 4], ['s', 3]]) {
    if (w.length > min && w.endsWith(suf)) {
      let base = w.slice(0, -suf.length);
      // "logging" -> "logg" -> "log". Undo the doubled consonant English adds before a suffix.
      if (base.length > 2 && /([bdfglmnprt])\1$/.test(base)) base = base.slice(0, -1);
      return base;
    }
  }
  return w;
}

export function terms(s) {
  const out = new Set();
  for (const raw of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;        // bare numbers match everything and mean nothing
    out.add(raw);                            // keep the surface form: "mcp", "api", exact names
    const st = stem(raw);
    if (st !== raw && st.length >= 2 && !STOP.has(st)) out.add(st);
  }
  return [...out];
}
