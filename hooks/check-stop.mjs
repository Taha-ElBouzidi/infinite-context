// Stop hook: inspect the final assistant message. the owner rule: his agent writes in
// plain handwritten language, so the chat reply must contain no em dash, no emoji,
// no arrows, no checkmarks, no decorative symbols. If it does, block and force a rewrite.
// Honors stop_hook_active so it can never infinite-loop. Fails open on any error.
import { readFileSync } from 'node:fs';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

// If we are already inside a stop-hook-triggered continuation, do not block again.
if (data.stop_hook_active === true) process.exit(0);

const tp = data.transcript_path;
if (!tp) process.exit(0);

let text = '';
try {
  const lines = readFileSync(tp, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    const content = obj && obj.message && obj.message.content;
    if (obj && obj.type === 'assistant' && Array.isArray(content)) {
      const t = content
        .filter(c => c && c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text)
        .join('\n');
      if (t) { text = t; break; }
    }
  }
} catch { process.exit(0); }

if (!text) process.exit(0);

const EM_DASH = new RegExp('\\u2014');
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]/u;
const SYMBOLS = /[\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2600}-\u{26FF}]/u;

// Slang denylist (English and French). Terms are assembled by concatenation so
// this file's own source never holds a contiguous banned phrase, which would
// otherwise make the content hook block edits to this hook. Phrase-anchored so a
// word like "calepinage" never trips the "se cale" rule. The source-of-truth list
// is memory/feedback_no_slang_idioms.md.
//
// JS's \b treats accented letters as non-word characters, so a plain \b right
// after "e"/"ee" (present in every accented "caler" conjugation) never matches,
// a pattern like recal(?:...|e|ee)\b can never actually match "recale"/"recalee"
// in any context. FR_START/FR_END use explicit letter-class lookaround instead of
// \b for every pattern that can end in an accented letter.
const FR_START = '(?<![a-zA-ZÀ-ÖØ-öø-ÿ])';
const FR_END = '(?![a-zA-ZÀ-ÖØ-öø-ÿ])';
const SLANG = [
  new RegExp('\\b' + 'nickel and ' + 'dimed' + '\\b', 'i'),
  new RegExp('\\b' + 'haggl' + '(?:e|es|ed|ing)\\b', 'i'),
  new RegExp('\\b' + 'knock ' + 'off' + '\\b', 'i'),
  new RegExp(FR_START + '(?:on\\s+se|se|on)\\s+' + 'cale' + '[rs]?' + FR_END, 'i'),
  new RegExp(FR_START + 'recal' + '(?:e|es|er|ons|ez|ent|é|ée)' + FR_END, 'i'),
  // Bare adjectival/predicate form ("c'est calé", "c'est bon c'est calé"), not just
  // the reflexive verb or the re- prefixed forms caught above.
  new RegExp(FR_START + 'cal' + '(?:é|ée|és|ées)' + FR_END, 'i'),
];

const hasEm = EM_DASH.test(text);
const hasEmoji = EMOJI.test(text);
const hasSymbol = SYMBOLS.test(text);
const hasSlang = SLANG.some(re => re.test(text));

if (hasEm || hasEmoji || hasSymbol || hasSlang) {
  const reasons = [];
  if (hasEm) reasons.push('an em dash');
  if (hasEmoji) reasons.push('an emoji');
  if (hasSymbol) reasons.push('an arrow, checkmark, or decorative symbol');
  if (hasSlang) reasons.push('a colloquial slang term (English or French)');
  const out = {
    decision: 'block',
    reason: 'Your last message contained ' + reasons.join(' and ') + '. the owner rule: write in plain professional language, no em dashes, no emojis, no arrows, no checkmarks, no slang. Rewrite using plain words. The banned slang list is in memory/feedback_no_slang_idioms.md.'
  };
  process.stdout.write(JSON.stringify(out));
}
process.exit(0);
