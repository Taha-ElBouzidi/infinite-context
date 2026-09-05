// Tier 2 contribute: open a pull request to the central brain with the current
// uncommitted changes. A secondary conversation runs this when it wants to propose
// a new fact, rule, or methodology. It never writes to master directly.
// Usage: node propose-to-brain.mjs "short description of what and why"
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Commit identity is instance config, brain.json.git {name, email}. With none, the repo's own
// git config applies. It was one person's Gmail address hardcoded until 2026-09-05.
function gitAuthorFlags() {
  try { const g = JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).git || {}; if (g.email) return ['-c', 'user.email=' + g.email, '-c', 'user.name=' + (g.name || 'brain')]; } catch { /* none */ }
  return [];
}
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Which repository proposals go to is instance config, brain.json.repo. With none, this hook
// does nothing: an engine has no upstream to propose to until its owner names one.
let REPO = '';
try { REPO = String(JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).repo || ''); } catch { /* none */ }
if (!REPO) process.exit(0);

function git(args, opts = {}) {
  return execSync('git ' + args, { cwd: BRAIN, encoding: 'utf8', timeout: opts.timeout || 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}

const desc = (process.argv.slice(2).join(' ') || 'brain proposal').replace(/"/g, "'");

let status = '';
try { status = git('status --porcelain'); } catch (e) { console.log('not a git repo or git failed'); process.exit(1); }
if (!status.trim()) { console.log('nothing to propose: no local changes'); process.exit(0); }

// Branch name from a host tag and a counter; avoid Date for determinism is not needed here.
let host = 'node';
try { host = (execSync('hostname', { encoding: 'utf8' }).trim() || 'node').replace(/[^A-Za-z0-9_-]/g, ''); } catch {}
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const branch = 'proposal/' + host + '-' + stamp;

try {
  git('pull --no-rebase --quiet', { timeout: 45000 });
  git('checkout -b ' + branch);
  git('add -A');
  execSync('git ' + gitAuthorFlags().map((x) => x.includes('=') ? '"' + x + '"' : x).join(' ') + ' commit -q -m "proposal: ' + desc + '"', { cwd: BRAIN, stdio: ['ignore', 'pipe', 'pipe'] });
  git('push -u origin ' + branch, { timeout: 45000 });
  const url = execSync('gh pr create --repo ' + REPO + ' --base master --head ' + branch + ' --title "proposal: ' + desc + '" --body "Proposed by a Tier 2 secondary node. What and why: ' + desc + '. Review and merge or reject."', { cwd: BRAIN, encoding: 'utf8', timeout: 30000 }).trim();
  console.log('PR opened: ' + url);
  // Return the checkout to master so the node is not stranded on the proposal
  // branch. GitHub auto-deletes the branch when the PR merges; a bare `git pull`
  // on a deleted branch then fails every sync until someone intervenes.
  try { git('checkout master'); } catch {}
} catch (e) {
  console.log('propose failed: ' + (e && e.message ? e.message.split('\n')[0] : 'unknown'));
  process.exit(2);
}
process.exit(0);
