// Binds every tailnet address as it appears, not only the ones present at startup.
//
// 2026-09-16, the first real reboot of SERVER: the brain server started at logon while Tailscale
// still had no address, read the interface list once, and served loopback only until it was
// restarted by hand. Every other machine lost the brain and the local health check stayed green.
// Tailscale can take minutes to come up, and it restarts itself on every update.
//
// bind() is called once per address. forget() lets a listener that failed be tried again the next
// time that address is present.
export function watchTailnet({ list, bind, intervalMs }) {
  const seen = new Set();
  const sweep = () => {
    for (const a of list()) {
      if (seen.has(a)) continue;
      seen.add(a);
      bind(a);
    }
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  return {
    stop() { clearInterval(timer); },
    forget(a) { seen.delete(a); },
  };
}
