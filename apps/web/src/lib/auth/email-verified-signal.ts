// story #4763 AC7 — the mailed link opens in a NEW tab; the gate that waits for it sits in the FIRST tab, which a hidden tab does not poll (PO 04:37Z) — so a person who went
// back to it only after a while waited up to 148 s on a screen that was already open on the server. The page that verifies announces «verified» to the other tabs of this browser;
// the gate checks at once when it hears it (also in a hidden tab). BroadcastChannel where there is one, the `storage` event of localStorage as the second way.
export const VERIFIED_SIGNAL = 'sprintable-email-verified';

/** Tell the other tabs of this browser that the e-mail was just verified (best effort: a browser without both ways just stays silent). */
export function announceVerified(): void {
  try {
    const channel = new BroadcastChannel(VERIFIED_SIGNAL);
    channel.postMessage({ at: Date.now() });
    channel.close();
  } catch { /* no BroadcastChannel */ }
  try {
    localStorage.setItem(VERIFIED_SIGNAL, String(Date.now()));
  } catch { /* storage blocked */ }
}

/** Run `onVerified` whenever another tab announces it; returns the way to stop listening. */
export function listenVerified(onVerified: () => void): () => void {
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(VERIFIED_SIGNAL);
    channel.onmessage = () => onVerified();
  } catch { channel = null; }
  const onStorage = (e: StorageEvent) => { if (e.key === VERIFIED_SIGNAL) onVerified(); };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('storage', onStorage);
    try { channel?.close(); } catch { /* already closed */ }
  };
}
