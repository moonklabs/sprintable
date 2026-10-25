/**
 * story 4780 (Kadir lens on 5232) — a tiny external store of «where this page is now» (`pathname + search`) for components that must follow client-side navigation without `next/navigation`'s hooks
 * (the tests that mock next/navigation in part broke when `useFlatHref` subscribed to `usePathname` — see hooks/use-flat-href.ts). The browser tells nothing when the app router calls
 * `history.pushState` / `replaceState`, so the two are wrapped (the wrapper calls the original first, then tells the listeners) and `popstate` (Back / Forward) is listened to.
 * The state (listeners · the wrappers installed · «popstate listened») lives on `window`, not in the module: a second instance of this module (HMR · a duplicated chunk) joins the same store instead of
 * wrapping the wrapper again.
 * A listener that throws never reaches the navigation and never stops the listeners after it.
 * The listeners are told in a microtask, not inside the call: Next's app router calls `history.pushState` INSIDE a `useInsertionEffect`, and a listener that makes React schedule a render right there is
 * a React error in development («useInsertionEffect must not schedule updates»). Several calls in a row are told once.
 * Whoever patches `history` after us wraps our wrapper (fine); whoever puts the native back (Next's app router does when it unmounts) removes it — so each subscription looks at whether the wrapper is
 * still the one in place and wraps again if not.
 */
type HistoryMethod = 'pushState' | 'replaceState';
interface LocationStore {
  listeners: Set<() => void>;
  installed: Partial<Record<HistoryMethod, History[HistoryMethod]>>;
  popstateListened: boolean;
  tellPending: boolean;
}
const STORE_KEY = '__sprintableLocationStore';

function store(): LocationStore {
  const w = window as unknown as Record<string, LocationStore | undefined>;
  return (w[STORE_KEY] ??= { listeners: new Set(), installed: {}, popstateListened: false, tellPending: false });
}

function tell(): void {
  const s = store();
  if (s.tellPending) return;
  s.tellPending = true;
  queueMicrotask(() => {
    s.tellPending = false;
    for (const listen of [...s.listeners]) {
      try { listen(); } catch { /* one bad listener must not break the others */ }
    }
  });
}

function ensureWrapped(): void {
  const s = store();
  for (const method of ['pushState', 'replaceState'] as const) {
    if (s.installed[method] && window.history[method] === s.installed[method]) continue;
    const original = window.history[method];
    const wrapper = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      tell();
      return result;
    };
    window.history[method] = wrapper;
    s.installed[method] = wrapper;
  }
  if (!s.popstateListened) {
    s.popstateListened = true;
    window.addEventListener('popstate', tell);
  }
}

export function subscribeToLocation(listen: () => void): () => void {
  ensureWrapped();
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
