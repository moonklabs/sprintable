import { DesktopRemoteOn } from '@/components/desktop/desktop-remote-on';

/**
 * story 4670 (U2 · AC3) — turn the org's «원격 제어» on, for the app band's [켜고 페어링] (and for anyone who is sent here). Opening this
 * address changes NOTHING: the switch turns on only by a press of [켜기] on the page, wherever it was opened — the app's window, a
 * browser, a link someone put in a chat or a doc (Kadir's lens 10-14: an address that switches on a whole org's remote control
 * is a state change riding on a navigation; the bridge says «inside the app», not «this person asked»). The org it turns on is the
 * session's — shown beside the button — never one named in the address. Login is the (authenticated) guard.
 */
export default function DesktopRemoteOnPage() {
  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <DesktopRemoteOn />
    </div>
  );
}
