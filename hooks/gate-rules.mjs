// The brain outage gate's rules (brain-gate.mjs and the mod import this file). Pure: no Node imports; the
// network probe and the diagnosis stay in brain-gate.mjs, which the mod runs itself when it needs them.
//
// The owner, 2026-10-15, after a laptop lost the brain for a few minutes and the hooks only warned: when the brain or the
// VPN it goes through is down, the agent repairs it before continuing, with no escape word. While the state file says down, every tool except
// reading and repair commands is refused, and the turn may not end once.

export const RETRIES_MS = [0, 4000, 8000];
export const PROBE_TIMEOUT_MS = 3000;
export const RECHECK_MS = 20000;
export const REPAIR_CMD = /\b(tailscale|brain-client|brain-probe|proxy-guard|proxy-state|TailscaleProxy|curl|ping|Test-NetConnection|Test-Connection|ipconfig|netsh|nslookup|Resolve-DnsName|tracert|route print|Get-NetAdapter|Get-NetIPAddress|Get-Service|Start-Service|Restart-Service|Get-ScheduledTask|Start-ScheduledTask|schtasks|Get-Process|Get-WinEvent|Get-Content|tasklist)\b/i;
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'SendMessage', 'ListAgents', 'TaskStop', 'TodoWrite']);

export const HOW = {
  local: 'The fault is on THIS machine. Repair it yourself: check tailscale status, restart the Tailscale service if it is stopped, check the network adapter. If the repair needs the user (for example joining another network), tell them exactly that in one line and stop.',
  server: 'The fault is on the brain host. Tell the user what failed and since when (or the main session there, with SendMessage, when one runs), then keep checking with node tools/brain-client.mjs status until the brain answers. Do not work on the task meanwhile.',
};

// Reading and network repair stay allowed while the brain is down.
export function toolExempt(tool, input) {
  const cmd = String((input && input.command) || '');
  return READ_TOOLS.has(tool) || ((tool === 'Bash' || tool === 'PowerShell') && REPAIR_CMD.test(cmd));
}

// The state file's last check is recent enough to trust without probing again.
export const fresh = (s, now) => now - ((s && s.checkedAt) || 0) < RECHECK_MS;

export function toolDenyReason(s) {
  return 'The brain is down (' + (s.detail || s.reason) + '). Repair it first: only reading and network repair commands run until it answers. ' + (HOW[s.kind] || HOW.local);
}

export function stopBlockReason(s) {
  return 'The brain is still down (' + (s.detail || s.reason) + '). Keep repairing it, or if the repair needs the user, tell them in one line exactly what to do. ' + (HOW[s.kind] || HOW.local);
}
