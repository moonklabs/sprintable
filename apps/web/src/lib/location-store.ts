/**
 * story 4780 (Kadir lens on 5232) — a tiny external store of «where this page is now» (`pathname + search`) for components that must follow client-side navigation without `next/navigation`'s hooks
 * (the tests that mock next/navigation in part broke when `useFlatHref` subscribed to `usePathname` — see hooks/use-flat-href.ts). The browser tells nothing when the app router calls
 * `history.pushState` / `replaceState`, so the two are wrapped ONCE (the wrapper calls the original first, then tells the listeners) and `popstate` (Back / Forward) is listened to.
 * Listeners are removed on unsubscribe; the wrapping stays for the page's life (it only calls the original and a possibly empty set).
 */
const listeners = new Set<() => void>();
let wrapped = false;

function tell(): void {
  listeners.forEach((listen) => listen());
}

function wrapHistoryOnce(): void {
  if (wrapped || typeof window === 'undefined') return;
  wrapped = true;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method];
    window.history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      tell();
      return result;
    };
  }
  window.addEventListener('popstate', tell);
}

export function subscribeToLocation(listen: () => void): () => void {
  wrapHistoryOnce();
  listeners.add(listen);
  return () => { listeners.delete(listen); };
}

export function readLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** test only */
export function _locationListenerCountForTests(): number {
  return listeners.size;
}
