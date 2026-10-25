/**
 * story 4780 (Kadir lens on 5232) — a tiny external store of «where this page is now» (`pathname + search`) for components that must follow client-side navigation without `next/navigation`'s hooks
 * (the tests that mock next/navigation in part broke when `useFlatHref` subscribed to `usePathname` — see hooks/use-flat-href.ts). The browser tells nothing when the app router calls
 * `history.pushState` / `replaceState`, so the two are wrapped (the wrapper calls the original first, then tells the listeners) and `popstate` (Back / Forward) is listened to.
 * The state (listeners · every wrapper installed · «popstate listened») lives on `window`, not in the module: a second instance of this module (HMR · a duplicated chunk) joins the same store instead of
 * wrapping the wrapper again.
 * A listener that throws never reaches the navigation and never stops the listeners after it.
 * The listeners are told in a microtask, not inside the call: Next's app router calls `history.pushState` INSIDE a `useInsertionEffect`, and a listener that makes React schedule a render right there is
 * a React error in development («useInsertionEffect must not schedule updates»). Several calls in a row are told once.
 * Whoever patches `history` after us wraps our wrapper (fine); whoever puts back what it captured (Next's app router does when it unmounts) may remove it — so each subscription looks at whether the
 * function in place is one of our wrappers (any we ever installed: what Next restores may be an older one) and wraps again if not.
 * Limit: that look happens on subscribe only; a subscriber that stays mounted while the router puts the native back is not told until another entry subscribes.
 */
type HistoryMethod = 'pushState' | 'replaceState';
interface LocationStore {
  listeners: Set<() => void>;
  ours: WeakSet<object>;
  popstateListened: boolean;
  tellPending: boolean;
}
const STORE_KEY = '__sprintableLocationStore';

function store(): LocationStore {
  const w = window as unknown as Record<string, Partial<LocationStore> | undefined>;
  const s = (w[STORE_KEY] ??= {});
  // a store left on `window` by an older copy of this file (Fast Refresh) may lack a field
  s.listeners ??= new Set();
  s.ours ??= new WeakSet();
  s.popstateListened ??= false;
  s.tellPending ??= false;
  return s as LocationStore;
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
    if (s.ours.has(window.history[method])) continue;
    const original = window.history[method];
    const wrapper = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      tell();
      return result;
    };
    window.history[method] = wrapper;
    s.ours.add(wrapper);
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
