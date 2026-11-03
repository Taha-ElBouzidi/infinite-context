// Decides whether staged hook code comes with a plugin version that machines will pick up.
// On master each commit is a release, so the version must move against HEAD. On a feature branch
// the branch ships as one release: the version must move against where the branch left master,
// and must also be above master's version now, or a master release with the same number made
// meanwhile would give two different builds one version.

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function versionGuard({ hookChange, branch, now, head, base, master }) {
  if (!hookChange.length) return { ok: true, message: 'no hook code staged, plugin version may stay' };
  const files = hookChange.join(', ');
  const onBranch = branch && branch !== 'master' && branch !== 'HEAD' && base;
  if (!onBranch) {
    if (head === now) return { ok: false, message: 'hook code is staged (' + files + ') but .claude-plugin/plugin.json is still ' + now + '. Bump the version, or no machine will ever load this change: claude plugin update compares versions, not content.' };
    if (head && compareVersions(now, head) < 0) return { ok: false, message: 'hook code is staged (' + files + ') but .claude-plugin/plugin.json goes down, ' + head + ' to ' + now + '. Raise it above ' + head + ': claude plugin update never installs a lower version.' };
    return { ok: true, message: 'hook change comes with a plugin version bump, ' + head + ' to ' + now };
  }
  if (compareVersions(now, base) <= 0) return { ok: false, message: 'hook code is staged on branch ' + branch + ' (' + files + ') but .claude-plugin/plugin.json is ' + now + ', not above ' + base + ' where the branch left master. Bump the version once for the branch.' };
  if (master && compareVersions(now, master) <= 0) return { ok: false, message: 'branch ' + branch + ' is at plugin version ' + now + ' but master is now at ' + master + '. Bump the branch above ' + master + ', or two different builds would carry the same version.' };
  return { ok: true, message: 'branch ' + branch + ' carries one plugin version bump, ' + base + ' to ' + now + (master ? ' (master is at ' + master + ')' : '') };
}
