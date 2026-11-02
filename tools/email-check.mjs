#!/usr/bin/env node
// Measurable checks on an email draft, run before the draft is shown to the owner.
//
// The owner, 2026-09-28: agent emails read like specs (every ask at once, numbered lists, stiff openers) and
// he writes no emails himself to learn a voice from, so the checks come from measured data instead:
// Boomerang 2016, 40 million emails (50 to 125 words, peak reply rate around 75 to 100; one to three
// questions; simple reading level), his own rule that a numbered list reads like a chore list, and the
// phrases that mark text as AI written. Numbers are guides for a first contact; a reply in a thread can
// be shorter. See memory/reference_how_to_write_an_email.md.
//
//   node tools/email-check.mjs draft.txt [--first]      exit 1 when a check fails
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { process.stderr.write('usage: node tools/email-check.mjs <draft.txt> [--first]\n'); process.exit(2); }
const FIRST = process.argv.includes('--first');
const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// HTML drafts (2026-10-23): two drafts passed every check here while Outlook showed paragraphs stuck together
// (a second style attribute dropped the margin) and black table borders (border="1"). These read the markup itself;
// the blocks in tools/email-blocks.html pass all of them.
const isHtml = /<(p|table|div|br|html|body)\b/i.test(source);
const htmlChecks = [];
if (isHtml) {
  const tags = source.match(/<[a-z][^>]*>/gi) || [];
  const doubleStyle = tags.filter((t) => (t.match(/\sstyle\s*=/gi) || []).length > 1);
  const borderOne = (source.match(/<table\b[^>]*\sborder\s*=\s*["']?[1-9]/gi) || []);
  const bareP = tags.filter((t) => /^<p\b/i.test(t) && !/style\s*=\s*["'][^"']*margin/i.test(t));
  // Every cell bordered applies to data tables (the ones with a header row); a callout, button, caption or image
  // cell is unbordered on purpose.
  const dataTables = (source.match(/<table\b[\s\S]*?<\/table>/gi) || []).filter((t) => /<th\b/i.test(t));
  const cellNoBorder = dataTables.flatMap((t) => t.match(/<t[dh]\b[^>]*>/gi) || [])
    // A bar cell (bgcolor, 1pt font, no text) inside a data table is a drawing, not a data cell (2026-10-23).
    .filter((t) => !/style\s*=\s*["'][^"']*border/i.test(t) && !/\bbgcolor\s*=|font-size\s*:\s*1pt/i.test(t));
  // Outlook ignores table margins, so two tables or boxes in a row touch unless a spacer paragraph sits between them.
  const stuckTables = (source.match(/<\/table>\s*<table\b/gi) || []).length;
  const kb = Math.round(Buffer.byteLength(source, 'utf8') / 1024);
  htmlChecks.push(
    ['one style per tag', doubleStyle.length === 0, doubleStyle.length ? doubleStyle.length + ' tag(s) with two style attributes (Outlook keeps one): ' + doubleStyle[0].slice(0, 80) : 'ok'],
    ['no border="1"', borderOne.length === 0, borderOne.length ? borderOne.length + ' table(s) with a border attribute; use border="0" and a 1px solid #999999 border on each cell' : 'ok'],
    ['paragraph margins', bareP.length === 0, bareP.length ? bareP.length + ' <p> with no margin in its style (they run together in Outlook); use margin:0 0 12pt 0' : 'ok'],
    ['bordered cells', cellNoBorder.length === 0, cellNoBorder.length ? cellNoBorder.length + ' table cell(s) with no border in the style: ' + cellNoBorder[0].slice(0, 80) : 'ok'],
    ['table spacing', stuckTables === 0, stuckTables ? stuckTables + ' place(s) where a table follows a table directly; put the SPACER block from tools/email-blocks.html between them' : 'ok'],
    ['size', kb <= 100, kb + ' KB (Gmail clips messages over about 100 KB)'],
  );
}
const raw = isHtml
  ? source.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
  : source;

// The body only: drop a Subject line and everything from the sign-off down, which should not count.
const lines = raw.split('\n');
const subject = (lines.find((l) => /^subject\s*:/i.test(l)) || '').replace(/^subject\s*:\s*/i, '');
let body = lines.filter((l) => !/^(subject|to|cc|objet)\s*:/i.test(l)).join('\n');
const signoff = body.search(/\n\s*(best regards|kind regards|regards|cordialement|bien cordialement|bien à vous|sincerely|thanks,|merci,)\s*,?\s*\n/i);
if (signoff > 0) body = body.slice(0, signoff);

const words = (body.match(/[\p{L}\p{N}'’-]+/gu) || []).length;
const questions = (body.match(/\?/g) || []).length;
const listLines = body.split('\n').filter((l) => /^\s*(\d+[.)]|[-*•])\s+\S/.test(l)).length;
// Abbreviations are protected before splitting: "Mr. Smith" used to end a sentence, which made a short false
// sentence and pulled the average down (2026-09-28).
const protectedBody = body.replace(/\b(Mr|Mrs|Ms|Dr|Mme|Mlle|No|St|vs|etc)\./gi, '$1').replace(/\b(e\.g|i\.e)\./gi, 'eg');
const sentences = protectedBody.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
const avgSentence = sentences.length ? Math.round(words / sentences.length) : 0;
// An average hides one long sentence: the same supplier email averaged 15 words with one sentence of about 50.
const sentenceWords = sentences.map((s) => (s.match(/[\p{L}\p{N}'’-]+/gu) || []).length);
const longest = sentenceWords.length ? Math.max(...sentenceWords) : 0;
const french = /\b(bonjour|vous|merci|nous|madame|monsieur)\b/i.test(body);

const AI_PHRASES = [
  'i hope this email finds you well', 'i hope this message finds you well', 'i hope you are doing well',
  'please do not hesitate', "don't hesitate to reach out", 'i am writing to', 'i wanted to reach out',
  'delve', 'leverage', 'robust', 'seamless', 'moreover', 'furthermore', 'in today', 'tapestry', 'underscore',
  'je me permets de', 'je souhaiterais', 'merci de me confirmer', 'je reste à votre disposition', "n'hésitez pas",
];
const lower = body.toLowerCase();
const aiHits = AI_PHRASES.filter((p) => lower.includes(p));
// Signs that we are shopping on price or leaking how we work (The owner, 2026-09-28, after follow-ups told suppliers
// "we are comparing several systems": "saying this hurts us"). A supplier should read a committed partner, never a
// comparison, a competitor, a public price, or an internal name.
const LEAK_PHRASES = [
  'comparing', 'compare', 'competitor', 'competing', 'other suppliers', 'other offers', 'several systems',
  'public price', 'retail price', 'list price', 'end user price', 'shortlist', 'best offer',
  'nous comparons', 'comparer', 'concurrent', 'prix public', 'autres fournisseurs',
];
const leakHits = LEAK_PHRASES.filter((p) => lower.includes(p));
const unaccented = french ? ['verification', 'materiel', 'vehicule', 'deja', 'etre', 'tres', 'equipe', 'securite'].filter((w) => new RegExp('\\b' + w + '\\b', 'i').test(body)) : [];

const checks = [
  ['length', FIRST ? words <= 125 : words <= 200, `${words} words (${FIRST ? 'first contact: 50 to 125' : 'aim under 200'})`],
  ['asks', questions <= (FIRST ? 2 : 3), `${questions} question marks (first contact: one, at most two)`],
  ['no list', listLines === 0, `${listLines} numbered or bulleted lines (never a list of asks to a person)`],
  ['plain sentences', avgSentence <= 22 && longest <= 30, `${avgSentence} words per sentence on average (aim under 22), longest ${longest} (at most 30)`],
  ['no AI phrases', aiHits.length === 0, aiHits.length ? 'found: ' + aiHits.join(', ') : 'none found'],
  ['no shopping signal', leakHits.length === 0, leakHits.length ? 'found: ' + leakHits.join(', ') + ' (write as a committed partner)' : 'none found'],
  // A reply keeps the thread's subject; shortening it would break the thread.
  ['subject', !subject || /^(re|tr|fwd?)\s*:/i.test(subject) || subject.split(/\s+/).length <= 9,
    !subject ? 'no subject line in the draft' : /^(re|tr|fwd?)\s*:/i.test(subject) ? 'reply or forward, thread subject kept' : `${subject.split(/\s+/).length} words`],
  ...(french ? [['French accents', unaccented.length === 0, unaccented.length ? 'missing accents: ' + unaccented.join(', ') : 'ok']] : []),
  ...htmlChecks,
];
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  process.stdout.write((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(20) + detail + '\n');
}
process.stdout.write(failed ? `${failed} check(s) failed\n` : 'all checks passed\n');
process.exit(failed ? 1 : 0);
