// Backup for keep-warm pings, run by dispatch.mjs only when the mod did not handle the prompt. The mod keeps a
// session warm by itself; the old per-session CronCreate timer is retired (keepwarm-rules.mjs says why). This never
// blocks a ping (a block shows in the chat): a timer's ping is told to delete its timer, any other ping to answer ok.
// Any other prompt passes untouched.
import { readFileSync } from 'node:fs';
import { isPingText, fromTimer, pingContext } from './keepwarm-rules.mjs';

let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
if (!isPingText(data.prompt)) process.exit(0);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: pingContext(!fromTimer(data)) } }));
process.exit(0);
