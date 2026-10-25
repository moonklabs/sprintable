/**
 * story 4780 (Kadir lens on 5232) — a tiny external store of «where this page is now» (`pathname + search`) for components that must follow client-side navigation without `next/navigation`'s hooks
 * (the tests that mock next/navigation in part broke when `useFlatHref` subscribed to `usePathname` — see hooks/use-flat-href.ts). The browser tells nothing when the app router calls
 * `history.pushState` / `replaceState`, so the two are wrapped ONCE (the wrapper calls the original first, then tells the listeners) and `popstate` (Back / Forward) is listened to.
 * The state (listeners · «wrapped») lives on `window`, not in the module: a second instance of this module (HMR · a duplicated chunk) joins the same store instead of wrapping the wrapper again.
 * A listener that throws never reaches the navigation (the router's own bookkeeping may sit inside the wrapped call) and never stops the listeners after it.
 */
interface LocationStore { listeners: Set<() => void>; wrapped: boolean }
const STORE_KEY = '__sprintableLocationStore';

function store(): LocationStore {
  const w = window as unknown as Record<string, LocationStore | undefined>;
  return (w[STORE_KEY] ??= { listeners: new Set(), wrapped: false });
}

function tell(): void {
  for (const listen of [...store().listeners]) {
    try { listen(); } catch { /* one bad listener must not break navigation or the others */ }
  }
}

function wrapHistoryOnce(): void {
  const s = store();
  if (s.wrapped) return;
  s.wrapped = true;
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
  const { listeners } = store();
  listeners.add(listen);
  return () => { listeners.delete(listen); };
}

export function readLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** test only */
export function _locationListenerCountForTests(): number {
  return store().listeners.size;
}
