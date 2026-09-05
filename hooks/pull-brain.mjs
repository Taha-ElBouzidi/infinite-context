// Tier 2 sync: pull master only, never push. Keeps a secondary node current with
// the central brain. Scheduled every 5 minutes on Tier 2 machines. Logs to .sync.log.
// Never throws.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { appendFileSync } from 'node:fs';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(BRAIN, '.sync.log');

function log(line) {
  try { appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n'); } catch {}
}

try {
  // Always sync master explicitly. A bare `git pull` follows the current
  // branch's upstream, so if the checkout is stranded on a proposal branch
  // (which GitHub deletes after merge) every pull fails. Checking out master
  // first self-heals that case. Ignore checkout failure (e.g. already on master).
  try { execSync('git checkout master --quiet', { cwd: BRAIN, stdio: 'ignore' }); } catch {}
  execSync('git pull --no-rebase --quiet origin master', { cwd: BRAIN, encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] });
  log('tier2 pull ok');
} catch (e) {
  log('tier2 pull FAILED (network or conflict)');
  try { execSync('git merge --abort', { cwd: BRAIN, stdio: 'ignore' }); } catch {}
}
process.exit(0);
