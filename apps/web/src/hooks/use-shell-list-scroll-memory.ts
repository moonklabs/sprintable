import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * story 4853 (phone · point 2) — coming back from a chat room, the page must be where it was left (the chat list above all).
 *
 * Measured on the phone app (the dev web inside the app's web view): the dashboard shell has ONE scroller (the `overflow-y-auto` column that holds the top bar, the
 * onboarding box and the page). A chat room scrolls that column down (`chat-view` → `bottomRef.scrollIntoView`, which also scrolls the scrollable ANCESTORS). Going back
 * to the list, the column keeps that offset: the list opens scrolled down by the height of the onboarding box («the box disappeared») — swiping down brings it back.
 *
 * What a page's place is and what a room's place is are different things: every page that is NOT a room has its own remembered place (by its path), written only while the
 * person is on that page; when they come back to a page from a room, that page's place is put back (a page never seen gets the top). Whatever a room does to the column
 * (open, scroll) never reaches those places. A person who goes into a room from the middle of a long list gets the middle of the list back; one who leaves from the top
 * gets the top (the onboarding box in view).
 */

/** `/chats/<id>` (also under a prefix such as `/<ws>/<proj>`): a chat room. `/chats` (the list) and everything else is not. */
export function isChatRoomPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return /(^|\/)chats\/[^/]+\/?$/.test(pathname);
}

/** How many animation frames (~1.5 s) the page is given to grow tall enough for the remembered place — it may render after the path changed (a Suspense boundary · a slow list). */
export const RESTORE_FRAMES = 90;
/** The most pages whose place is kept (the oldest goes first). */
export const MAX_REMEMBERED_PAGES = 30;

type Scroller = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight' | 'addEventListener' | 'removeEventListener'>;

/** Puts the column at `top`. Outside the hook on purpose: moving a DOM element is not a state change of the hook (the `react-hooks/immutability` rule reads an assignment inside the hook as one). */
function putScrollTop(scroller: Scroller, top: number): void {
  scroller.scrollTop = top;
}

function remember(places: Map<string, number>, path: string, top: number): void {
  places.delete(path); // the newest goes last
  places.set(path, top);
  if (places.size > MAX_REMEMBERED_PAGES) {
    const oldest = places.keys().next().value;
    if (oldest !== undefined) places.delete(oldest);
  }
}

export function useShellListScrollMemory(scroller: Scroller | null, pathname: string | null | undefined): void {
  const placesRef = useRef<Map<string, number>>(new Map());
  const pathRef = useRef(pathname);
  const prevPathRef = useRef(pathname);
  const pendingRef = useRef<string | null>(null); // a room → page move whose place is not put back yet (the column may not be there yet)
  // the restore that is running: `own` = where it put the column (the scroll event of THAT assignment — a clamped one too — is not a move of the person's), `moved` = a real move
  // (any other scroll event) happened since: from then on the restore is over and the column is left alone, wherever the move ended
  const restoreRef = useRef<{ own: number | null; moved: boolean } | null>(null);

  // read by the scroll listener: a scroll that happens in a room is not a page's (kept in a layout effect — a ref is not written while rendering)
  useLayoutEffect(() => { pathRef.current = pathname; }, [pathname]);

  // a page's own place, while the person is on a page that is not a room
  useEffect(() => {
    if (!scroller) return undefined;
    const onScroll = () => {
      const path = pathRef.current;
      if (!path || isChatRoomPath(path)) return;
      const restore = restoreRef.current;
      if (restore && restore.own !== null && scroller.scrollTop === restore.own) return; // the restore's own assignment, not a move
      remember(placesRef.current, path, scroller.scrollTop);
      if (restore) { restore.own = null; restore.moved = true; } // a real move: every event counts from here on (also one back to the very place the restore chose) and the restore is over
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scroller]);

  // a room → a page that is not a room: put that page's place back
  useLayoutEffect(() => {
    const prev = prevPathRef.current;
    if (prev !== pathname) {
      prevPathRef.current = pathname;
      // a move to anywhere else drops a restore that was still waiting; a room → page move starts one
      pendingRef.current = isChatRoomPath(prev) && pathname && !isChatRoomPath(pathname) ? pathname : null;
    }
    const path = pendingRef.current;
    if (!path || !scroller) return undefined; // no column yet: the restore waits (the effect runs again when it comes)
    pendingRef.current = null;
    const target = placesRef.current.get(path) ?? 0;
    putScrollTop(scroller, target);
    const placed = scroller.scrollTop; // what the browser kept (it clamps to the page's height)
    const restore = { own: placed as number | null, moved: false };
    restoreRef.current = restore;
    let frames = 0;
    let raf = 0;
    const finish = () => { if (restoreRef.current === restore) restoreRef.current = null; };
    // The page may not be tall enough yet (it renders after the path changed, so the column was clamped): look again for a few frames while NOTHING has moved the column
    // since the place was put; the moment someone else moved it (a finger · a hash · another scroll — seen as a scroll event, so a move that ended exactly where the column
    // was also counts) it is left alone, and when the place becomes reachable it is set once more.
    const retry = () => {
      if (restore.moved || scroller.scrollTop === target || scroller.scrollTop !== placed) { finish(); return; }
      if (scroller.scrollHeight - scroller.clientHeight >= target) { putScrollTop(scroller, target); restore.own = target; raf = requestAnimationFrame(finish); return; } // its event (async) is not a move either; the next frame ends the restore
      if (frames >= RESTORE_FRAMES) { finish(); return; }
      frames += 1;
      raf = requestAnimationFrame(retry);
    };
    raf = requestAnimationFrame(retry);
    return () => { if (raf) cancelAnimationFrame(raf); finish(); };
  }, [pathname, scroller]);
}
