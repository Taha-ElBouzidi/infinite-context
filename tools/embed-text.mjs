// What the meaning index embeds for one memory, shared by build-embeddings.mjs (which embeds it) and
// build-index.mjs (which hashes it to know when the vectors are stale). The two MUST agree, the same
// reason tokenize.mjs is shared: if they drift, an edit either rebuilds on every run or never.
//
// Name, description and the start of the body. Until 2026-09-25 it was name and description only,
// so the meaning channel saw the same text as the keyword channel and a test measured the method,
// not the extra text. Measured that day on 282 of the owner's real messages: adding the body start
// raised single questions found from 130 to 145 of 167 and two-memory questions from 51 to 59 of 115
// (with the recall bars retuned to 0.50 and 0.5). It helped every one of five models tried. The
// keyword channel still reads the description only: body text there made recall WORSE on 2026-08-07.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BODY_CHARS = 1200;

export function bodyStart(brain, slug) {
  try {
    const raw = readFileSync(join(brain, 'memory', slug + '.md'), 'utf8').split(String.fromCharCode(13)).join('');
    const end = raw.startsWith('---') ? raw.indexOf(String.fromCharCode(10) + '---', 3) : -1;
    return (end > 0 ? raw.slice(end + 4) : raw).replace(/\s+/g, ' ').trim().slice(0, BODY_CHARS);
  } catch { return ''; }
}

export function embedText(brain, slug, description) {
  return slug.replace(/_/g, ' ') + '. ' + (description || '') + ' ' + bodyStart(brain, slug);
}

export function textHash(brain, descriptions) {
  const str = Object.keys(descriptions).sort()
    .map((s) => s + String.fromCharCode(0) + embedText(brain, s, descriptions[s])).join(String.fromCharCode(1));
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
