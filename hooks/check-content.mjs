// PreToolUse hook: block banned characters in file writes and bash commands.
// the owner rule: his communication and documents use plain handwritten language,
// no em dash, no emoji, no arrows, no checkmarks. But real code files must not
// be broken by symbols that legitimately appear in code, so:
//   - markdown/text/doc files: strict (em dash + emoji + arrows + checkmarks + symbols)
//   - code files and bash commands: lenient (em dash + true pictographic emoji only)
// Fails open on any error so a hook bug can never block legitimate work.
import { readFileSync } from 'node:fs';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch { process.exit(0); }

const tool = data.tool_name || '';
const ti = data.tool_input || {};
let text = '';
let filePath = '';
// Outbound-message MCP tools (chat sends, Gmail/Outlook drafts and sends, Slack
// posts, etc.) never write a file, so they fall outside the Write/Edit/Bash checks
// below. Sweep every string field in tool_input for these instead, since the exact
// field name (text, body, content...) varies by integration.
const isOutboundMessageTool = /^mcp__/.test(tool)
  && /(send_message|send_mail|send_draft|create_draft|reply|post_message)/i.test(tool);
if (tool === 'Write') { text = String(ti.content || ''); filePath = String(ti.file_path || ''); }
else if (tool === 'Edit') { text = String(ti.new_string || ''); filePath = String(ti.file_path || ''); }
else if (tool === 'NotebookEdit') { text = String(ti.new_source || ''); filePath = String(ti.notebook_path || ''); }
else if (tool === 'Bash') { text = String(ti.command || ''); filePath = ''; }
else if (isOutboundMessageTool) {
  text = Object.values(ti).filter(v => typeof v === 'string').join('\n');
  filePath = '';
}
else process.exit(0);

const EM_DASH = new RegExp('\\u2014');
// True pictographic emoji only (safe to block anywhere, never legitimate in the owner content).
const EMOJI_CORE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]/u;
// Extra symbols (arrows, checkmarks, stars, warning, dingbats) blocked only in prose/docs.
const SYMBOLS_PROSE = /[\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2600}-\u{26FF}]/u;

// Slang denylist (English and French). Concatenated so this file's own source
// holds no contiguous banned phrase. Phrase-anchored so a word like "calepinage"
// never trips the "se cale" rule. The slang memory file and the hooks directory
// are exempt: they legitimately contain the terms they govern.
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
const slangExempt = /feedback_no_slang_idioms\.md$/i.test(filePath)
  || /reference_js_regex_accent_boundary\.md$/i.test(filePath)
  || /[\\/]hooks[\\/]/i.test(filePath);

const isProse = /\.(md|markdown|txt|mdx|rst)$/i.test(filePath);

const hasEm = EM_DASH.test(text);
const hasEmoji = EMOJI_CORE.test(text);
const hasSymbol = isProse && SYMBOLS_PROSE.test(text);
const hasSlang = !slangExempt && SLANG.some(re => re.test(text));

if (hasEm || hasEmoji || hasSymbol || hasSlang) {
  const reasons = [];
  if (hasEm) reasons.push('an em dash (U+2014)');
  if (hasEmoji) reasons.push('an emoji');
  if (hasSymbol) reasons.push('an arrow, checkmark, or symbol (not allowed in documents)');
  if (hasSlang) reasons.push('a colloquial slang term (English or French)');
  const where = filePath ? ('the file ' + filePath) : ('this ' + tool + ' command');
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Blocked by brain rule: ' + where + ' contains ' + reasons.join(' and ') + '. the owner rule: plain professional language, no em dashes, no emojis, no arrows or checkmarks, no slang. Remove it and retry. The banned slang list is in memory/feedback_no_slang_idioms.md.'
    }
  };
  process.stdout.write(JSON.stringify(out));
}
process.exit(0);
