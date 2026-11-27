// story 5031 (C1 step 5a-2) — who opens the «새 프로젝트» dialog when the desktop app asks (the sidebar's «새 프로젝트» line → OPEN_NEW_PROJECT_EVENT · the app menu's ⌘N → the `new_project=1` flag on the page address).
// Every project switcher owns its own dialog (UnifiedSwitcher in the list column · in the icon bar's account popover · the desktop top bar's path), so two of them mounted together would each open one — two dialogs on one press.
// This registry is the ONE place that decides: instances register while mounted, the event / the flag reaches exactly ONE of them — the highest priority (the top bar's path: always mounted from lg), ties → the one registered last. A switcher mounted alone (a test of the sidebar) is simply the owner.
// A browser has no bridge: nothing registers, and the event / the flag open nothing (the flag is left alone), as before.
// Limit (intended, not fixed): the ⌘N flag is read when an instance REGISTERS (once per mount, in the microtask after it). The app puts the flag on the address it loads, so it is there before the page's scripts run; a flag that arrives later on an already mounted page
// (the app never pushes script into the page) is not read — the window event is the way for a page that is already open. Reading the address on every navigation would add a listener and a place that can open the dialog twice; not worth it for a door the app does not use.
import { desktopApp } from '@/lib/desktop-app';
import { NEW_PROJECT_PARAM, OPEN_NEW_PROJECT_EVENT } from '@/components/nav/new-project-entry';

interface Owner { open: () => void; priority: number }
const owners: Owner[] = [];

const best = (): Owner | undefined => owners.reduce<Owner | undefined>((a, b) => (!a || b.priority >= a.priority ? b : a), undefined);
const onEvent = () => { best()?.open(); };

/** the app menu's ⌘N: the flag on the page address — read once, taken off (a reload must not open it again), and handed to the owner */
function consumeFlag() {
  if (owners.length === 0 || typeof window === 'undefined') return;
  const here = new URL(window.location.href);
  if (here.searchParams.get(NEW_PROJECT_PARAM) !== '1') return;
  here.searchParams.delete(NEW_PROJECT_PARAM);
  window.history.replaceState(window.history.state, '', `${here.pathname}${here.search}${here.hash}`);
  onEvent();
}

/** Register an instance that can open the dialog. Returns the unregister. Nothing is registered outside the app (no bridge). */
export function registerNewProjectOwner(open: () => void, priority = 0): () => void {
  if (typeof window === 'undefined' || !desktopApp()) return () => undefined;
  const me: Owner = { open, priority };
  if (owners.length === 0) window.addEventListener(OPEN_NEW_PROJECT_EVENT, onEvent);
  owners.push(me);
  // every instance of this commit has registered by the time the microtask runs: the flag goes to the best of them, once
  queueMicrotask(consumeFlag);
  return () => {
    const i = owners.indexOf(me);
    if (i >= 0) owners.splice(i, 1);
    if (owners.length === 0) window.removeEventListener(OPEN_NEW_PROJECT_EVENT, onEvent);
  };
}

/** tests only: how many instances are registered */
export function __newProjectOwnerCount(): number { return owners.length; }
