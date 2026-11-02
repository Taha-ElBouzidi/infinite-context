// The writing rules as code, in one place: the PreToolUse content check (check-content.mjs), the end-of-reply
// check (check-stop.mjs), the note shown on the next message (style-note.mjs) and the mod all import this
// file, so a rule changed here changes everywhere (the mod's copy is checked against this one at its build).
// Pure: no Node imports, so the mod can load it.
//
// The rule: communication and documents use plain handwritten language, no em dash, no emoji, no arrows,
// no checkmarks. Real code files must not be broken by symbols that legitimately appear in code, so:
//   - markdown/text/doc files: strict (em dash + emoji + arrows + checkmarks + symbols)
//   - code files and shell commands: lenient (em dash + true pictographic emoji only)
// PowerShell commands are checked like Bash (hook review 2026-10-30: the old matcher missed them).

export const EM_DASH = new RegExp('\\u2014');
// True pictographic emoji only (safe to block anywhere, never legitimate in prose).
export const EMOJI_CORE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]/u;
// Extra symbols (arrows, checkmarks, stars, warning, dingbats) blocked only in prose/docs.
export const SYMBOLS_PROSE = /[\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2600}-\u{26FF}]/u;

// Slang denylist (English and French). Concatenated so this file's own source holds no contiguous banned phrase.
// Phrase-anchored so a word like "calepinage" never trips the "se cale" rule. The source-of-truth list is
// memory/feedback_no_slang_idioms.md.
//
// JS's \b treats accented letters as non-word characters, so a plain \b right after "e"/"ee" (present in every
// accented "caler" conjugation) never matches. FR_START/FR_END use explicit letter-class lookaround instead.
const FR_START = '(?<![a-zA-Z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF])';
const FR_END = '(?![a-zA-Z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF])';
export const SLANG = [
  new RegExp('\\b' + 'nickel and ' + 'dimed' + '\\b', 'i'),
  new RegExp('\\b' + 'haggl' + '(?:e|es|ed|ing)\\b', 'i'),
  new RegExp('\\b' + 'knock ' + 'off' + '\\b', 'i'),
  new RegExp(FR_START + '(?:on\\s+se|se|on)\\s+' + 'cale' + '[rs]?' + FR_END, 'i'),
  new RegExp(FR_START + 'recal' + '(?:e|es|er|ons|ez|ent|\\u00E9|\\u00E9e)' + FR_END, 'i'),
  // Bare adjectival/predicate form, not just the reflexive verb or the re- prefixed forms caught above.
  new RegExp(FR_START + 'cal' + '(?:\\u00E9|\\u00E9e|\\u00E9s|\\u00E9es)' + FR_END, 'i'),
];

// Outbound-message MCP tools (chat sends, mail drafts and sends, Slack posts) never write a file; every string field
// of their input is checked, since the field name (text, body, content) varies by integration.
export const OUTBOUND = /(send_message|send_mail|send_draft|create_draft|reply|post_message)/i;

// What a tool call would write or send, and where; null when the call writes nothing these rules cover.
export function contentOf(tool, input) {
  const ti = input || {};
  if (tool === 'Write') return { text: String(ti.content || ''), filePath: String(ti.file_path || '') };
  if (tool === 'Edit') return { text: String(ti.new_string || ''), filePath: String(ti.file_path || '') };
  if (tool === 'NotebookEdit') return { text: String(ti.new_source || ''), filePath: String(ti.notebook_path || '') };
  if (tool === 'Bash' || tool === 'PowerShell') return { text: String(ti.command || ''), filePath: '' };
  if (/^mcp__/.test(tool) && OUTBOUND.test(tool)) return { text: Object.values(ti).filter((v) => typeof v === 'string').join('\n'), filePath: '' };
  return null;
}

export function contentProblems(tool, input) {
  const c = contentOf(tool, input);
  if (!c) return null;
  const { text, filePath } = c;
  // The slang memory file and the hooks directory legitimately contain the terms they govern.
  const slangExempt = /feedback_no_slang_idioms\.md$/i.test(filePath)
    || /reference_js_regex_accent_boundary\.md$/i.test(filePath)
    || /[\\/]hooks[\\/]/i.test(filePath);
  const isProse = /\.(md|markdown|txt|mdx|rst)$/i.test(filePath);
  const reasons = [];
  if (EM_DASH.test(text)) reasons.push('an em dash (U+2014)');
  if (EMOJI_CORE.test(text)) reasons.push('an emoji');
  if (isProse && SYMBOLS_PROSE.test(text)) reasons.push('an arrow, checkmark, or symbol (not allowed in documents)');
  if (!slangExempt && SLANG.some((re) => re.test(text))) reasons.push('a colloquial slang term (English or French)');
  if (!reasons.length) return null;
  return { reasons, where: filePath ? ('the file ' + filePath) : ('this ' + tool + ' command') };
}

export function contentDenyReason(p) {
  return 'Blocked by brain rule: ' + p.where + ' contains ' + p.reasons.join(' and ') + '. Rule: plain professional language, no em dashes, no emojis, no arrows or checkmarks, no slang. Remove it and retry. The banned slang list is in hooks/content-rules.mjs.';
}

// The finished reply: every symbol counts, code or not, since a chat reply is prose.
export function styleProblems(text) {
  const t = String(text || '');
  const reasons = [];
  if (EM_DASH.test(t)) reasons.push('an em dash');
  if (EMOJI_CORE.test(t)) reasons.push('an emoji');
  if (SYMBOLS_PROSE.test(t)) reasons.push('an arrow, checkmark, or decorative symbol');
  if (SLANG.some((re) => re.test(t))) reasons.push('a colloquial slang term (English or French)');
  return reasons;
}

// The owner, 2026-10-22: a forced rewrite costs a whole extra reply, so the reply stays and the slip is put in front of
// the agent at the start of its next message.
export function slipNote(reasons) {
  return 'WRITING SLIP IN YOUR LAST REPLY: it contained ' + reasons.join(' and ')
    + '. It was not rewritten, to save cost. Do not repeat it: plain words only, no em dashes, no emoji, no arrows, no checkmarks, no slang (the list is in hooks/content-rules.mjs).';
}
