// @vitest-environment jsdom
//
// story 4853 (phone · point 2) — coming back from a chat room a page is where it was left (the chat list above all); whatever a room does to the shell's scroll column
// never reaches a page's place. The shell has ONE scroller; a room scrolls it down (chat-view's scrollIntoView also scrolls the ancestors). This file holds the hook that
// remembers each page's own place.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { isChatRoomPath, useShellListScrollMemory, RESTORE_FRAMES, MAX_REMEMBERED_PAGES } from './use-shell-list-scroll-memory';

/** A scroll column that clamps like a browser: the place can not be beyond (scrollHeight − clientHeight). */
class FakeScroller {
  private top = 0;
  scrollHeight = 3000;
  clientHeight = 800;
  private listeners = new Set<() => void>();
  addEventListener = vi.fn((type: string, fn: () => void) => { if (type === 'scroll') this.listeners.add(fn); });
  removeEventListener = vi.fn((type: string, fn: () => void) => { if (type === 'scroll') this.listeners.delete(fn); });
  get scrollTop() { return this.top; }
  set scrollTop(v: number) { this.top = Math.max(0, Math.min(v, Math.max(0, this.scrollHeight - this.clientHeight))); }
  /** the scroll event the browser fires after the position changed */
  fire() { this.listeners.forEach((fn) => fn()); }
  /** a scroll that happens in the column (the person's finger · or a room's scrollIntoView): the position changes and the event fires */
  scrollTo(top: number) { this.scrollTop = top; this.fire(); }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ scroller, path }: { scroller: HTMLElement | null; path: string }) {
  useShellListScrollMemory(scroller, path);
  return null;
}

function setup(initialPath: string, withScroller = true) {
  const scroller = new FakeScroller();
  const root = createRoot(document.createElement('div'));
  let attached = withScroller;
  let current = initialPath;
  const render = () => { act(() => { root.render(<Harness scroller={attached ? (scroller as unknown as HTMLElement) : null} path={current} />); }); };
  const go = (path: string) => { current = path; render(); };
  const attach = (on: boolean) => { attached = on; render(); };
  render();
  return { scroller, go, attach, unmount: () => act(() => root.unmount()) };
}

/** requestAnimationFrame as a queue the test runs by hand */
function frameQueue() {
  const frames: Array<() => void> = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(() => cb(0)); return frames.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  return { frames, runOne: () => frames.shift()?.(), runAll: (max = 500) => { let n = 0; while (frames.length && n < max) { frames.shift()!(); n += 1; } return n; } };
}

describe('isChatRoomPath', () => {
  it('a room is /chats/<id> (also under a prefix) · the list and everything else is not', () => {
    expect(isChatRoomPath('/chats/abc-123')).toBe(true);
    expect(isChatRoomPath('/chats/abc-123/')).toBe(true);
    expect(isChatRoomPath('/ws/proj/chats/abc-123')).toBe(true);
    expect(isChatRoomPath('/chats')).toBe(false);
    expect(isChatRoomPath('/chats/')).toBe(false);
    expect(isChatRoomPath('/ws/proj/chats')).toBe(false);
    expect(isChatRoomPath('/dashboard')).toBe(false);
    expect(isChatRoomPath('/chats/abc/thread')).toBe(false);
    expect(isChatRoomPath(null)).toBe(false);
    expect(isChatRoomPath(undefined)).toBe(false);
  });
});

describe('useShellListScrollMemory', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('ⓐ leaving the list from the top: a room scrolls the column down, coming back the list is at the top again (the onboarding box in view)', () => {
    const { scroller, go } = setup('/chats');
    go('/chats/room-1');
    scroller.scrollTo(900); // the room: scrollIntoView on the last message moved the shell column
    go('/chats');
    expect(scroller.scrollTop).toBe(0);
  });

  it('ⓑ leaving the list from the middle (the third room): coming back the list is in that place', () => {
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300); // the person scrolled the list down to the third room
    go('/chats/room-3');
    scroller.scrollTo(900); // the room
    go('/chats');
    expect(scroller.scrollTop).toBe(300);
  });

  it('ⓒ scrolling inside a room does not change the list\'s place', () => {
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollTo(900);
    scroller.scrollTo(1200);
    scroller.scrollTo(100);
    go('/chats');
    expect(scroller.scrollTop).toBe(300);
  });

  it('the list\'s place is the last one before the room — a second trip uses the new one', () => {
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-1');
    go('/chats');
    expect(scroller.scrollTop).toBe(300);
    scroller.scrollTo(500);
    go('/chats/room-2');
    scroller.scrollTo(700);
    go('/chats');
    expect(scroller.scrollTop).toBe(500);
  });

  it('every page has its OWN place: another page\'s scroll never becomes the list\'s (codex 1)', () => {
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300); // the list
    go('/glance');
    scroller.scrollTo(800); // another page
    go('/chats/room-1');
    scroller.scrollTo(900);
    go('/chats');
    expect(scroller.scrollTop).toBe(300); // the list's own place, not the glance page's 800
    go('/chats/room-2');
    go('/glance');
    expect(scroller.scrollTop).toBe(800); // …and the glance page gets its own place back from a room
    go('/chats/room-3');
    go('/inbox');
    expect(scroller.scrollTop).toBe(0); // a page never seen starts at its top
  });

  it('room → room and every move that is not «from a room» leave the column alone', () => {
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/dashboard');
    expect(scroller.scrollTop).toBe(300);
    scroller.scrollTo(500); // another page: its own place
    go('/chats');
    expect(scroller.scrollTop).toBe(500); // page → page is not a way back from a room: nothing is put back
    go('/chats/room-1');
    scroller.scrollTo(900);
    go('/chats/room-2'); // room → room: not a page's place to put back
    expect(scroller.scrollTop).toBe(900);
  });

  it('another page that puts the column at its own place (no scroll event) is not undone when the person goes back to the list from it', () => {
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/dashboard');
    scroller.scrollTop = 0; // the other page starts at its top (set by the browser / the page — no scroll event reached the memory)
    go('/chats');
    expect(scroller.scrollTop).toBe(0); // only a way back FROM A ROOM puts a remembered place back
  });

  it('a room opened by a link (no list before it): back to the list is the top', () => {
    const { scroller, go } = setup('/chats/room-1');
    scroller.scrollTo(900);
    go('/chats');
    expect(scroller.scrollTop).toBe(0);
  });

  it('the person swipes before the first frame: that move is left alone, not reset to the old place (codex 1)', () => {
    const q = frameQueue();
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollTo(900);
    go('/chats'); // the place is put back at once (300) …
    expect(scroller.scrollTop).toBe(300);
    scroller.scrollTo(500); // … and before the next frame a finger (or a hash scroll) moves the column
    q.runAll();
    expect(scroller.scrollTop).toBe(500);
  });

  it('another piece of code moves the column without a scroll event while the restore waits for the list: the restore does not override that either', () => {
    const q = frameQueue();
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollHeight = 800;
    go('/chats'); // 300 is clamped to 0
    scroller.scrollHeight = 3000;
    scroller.scrollTop = 120; // set directly (a hash scroll · a page's own scrollTo) — no event reached the memory
    q.runAll();
    expect(scroller.scrollTop).toBe(120);
  });

  it('a finger that goes away and comes back to where the clamped column was, before the retry frame: the restore does not override it (codex)', () => {
    const q = frameQueue();
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollHeight = 800; // the list is not there yet
    go('/chats'); // 300 is clamped to 0
    scroller.fire(); // the clamped assignment's own event
    scroller.scrollHeight = 3000; // the list is there now
    scroller.scrollTo(500); // a finger …
    scroller.scrollTo(0); // … and back to exactly where the clamped column was (placed)
    q.runAll();
    expect(scroller.scrollTop).toBe(0); // the person's move is theirs; 300 is not put back over it
  });

  it('the person moves away and straight back to the very place the restore chose, before the next frame: that return is remembered too (codex)', () => {
    const q = frameQueue();
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollTo(900);
    go('/chats'); // put back at 300
    scroller.scrollTo(500); // a finger
    scroller.scrollTo(300); // … and back to exactly the restored place, still before the next frame
    q.runAll();
    go('/chats/room-4');
    scroller.scrollTo(900);
    go('/chats');
    expect(scroller.scrollTop).toBe(300); // not the 500 of the middle of that move
  });

  it('the list renders a moment after the path changed: the column was clamped, the place is set again once the list is tall enough (and then left alone)', () => {
    const q = frameQueue();
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollTo(900);
    scroller.scrollHeight = 800; // the list is not rendered yet: nothing to scroll
    go('/chats');
    expect(scroller.scrollTop).toBe(0); // clamped
    scroller.fire(); // the clamped assignment's own scroll event must not become the list's place (codex 4)
    q.runOne(); // a frame later: still short
    expect(scroller.scrollTop).toBe(0);
    scroller.scrollHeight = 3000; // the list rendered
    q.runOne();
    expect(scroller.scrollTop).toBe(300);
    scroller.scrollTo(120); // the person moved it afterwards — never chased
    q.runAll();
    expect(scroller.scrollTop).toBe(120);
  });

  it('the clamped assignment\'s scroll event did not overwrite the place: a second trip still comes back to it', () => {
    const q = frameQueue();
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollHeight = 800;
    go('/chats');
    scroller.fire(); // scrollTop is 0 now (clamped) — an event that must not be taken for the list's place
    scroller.scrollHeight = 3000;
    q.runAll(); // the place (300) is reached
    expect(scroller.scrollTop).toBe(300);
    go('/chats/room-4');
    scroller.scrollTo(900);
    go('/chats');
    expect(scroller.scrollTop).toBe(300);
  });

  it('a list that renders late (not in the first moments) is still reached — about a second and a half is given', () => {
    const q = frameQueue();
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollHeight = 800;
    go('/chats');
    for (let i = 0; i < 60; i += 1) q.runOne(); // a slow list: 60 frames of nothing to scroll
    expect(scroller.scrollTop).toBe(0);
    scroller.scrollHeight = 3000;
    q.runOne();
    expect(scroller.scrollTop).toBe(300);
  });

  it('gives up after a bounded number of frames when the list never gets tall enough', () => {
    const q = frameQueue();
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollHeight = 800;
    go('/chats');
    const ran = q.runAll(RESTORE_FRAMES + 50);
    expect(q.frames.length).toBe(0);
    expect(ran).toBeLessThanOrEqual(RESTORE_FRAMES + 1);
  });

  it('the column is not there for a moment on the way back: the restore waits for it and is not lost (codex 3)', () => {
    const { scroller, go, attach } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollTo(900);
    attach(false); // the shell re-mounts its column: no element for a moment
    go('/chats');
    attach(true); // … and it comes back (the same element object here)
    expect(scroller.scrollTop).toBe(300);
  });

  it('a new move while a restore waits for the column drops that restore', () => {
    const { scroller, go, attach } = setup('/chats');
    scroller.scrollTo(300);
    go('/chats/room-3');
    scroller.scrollTo(900);
    attach(false);
    go('/chats');
    go('/chats/room-4'); // the person went into another room before the column was back
    attach(true);
    expect(scroller.scrollTop).toBe(900); // nothing was put back
  });

  it('remembers a bounded number of pages (the oldest goes first)', () => {
    const { scroller, go } = setup('/p0');
    for (let i = 0; i <= MAX_REMEMBERED_PAGES; i += 1) { // one more page than the limit
      go(`/p${i}`);
      scroller.scrollTo(100 + i);
    }
    go('/chats/room-1');
    go('/p0'); // the oldest page was dropped: back at its top
    expect(scroller.scrollTop).toBe(0);
    go('/chats/room-2');
    go(`/p${MAX_REMEMBERED_PAGES}`); // the newest is kept
    expect(scroller.scrollTop).toBe(100 + MAX_REMEMBERED_PAGES);
  });

  it('scrolls inside rooms are not remembered at all: many rooms never push a page\'s place out of the bounded memory', () => {
    const { scroller, go } = setup('/chats');
    scroller.scrollTo(300); // the list
    go('/chats/r0');
    for (let i = 0; i <= MAX_REMEMBERED_PAGES + 5; i += 1) { // more rooms than the memory holds, each scrolled in
      go(`/chats/r${i}`);
      scroller.scrollTo(500 + i);
    }
    go('/chats');
    expect(scroller.scrollTop).toBe(300);
  });

  it('removes its scroll listener when it goes away', () => {
    const { scroller, unmount } = setup('/chats');
    expect(scroller.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
    unmount();
    expect(scroller.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('no scroller at all (the column is not mounted): nothing happens and nothing throws', () => {
    const { go } = setup('/chats', false);
    expect(() => { go('/chats/room-1'); go('/chats'); }).not.toThrow();
  });
});

describe('the shell uses the hook (source shape · comments stripped)', () => {
  const RAW = readFileSync(join(__dirname, '..', 'app', 'dashboard', 'dashboard-shell.tsx'), 'utf8');
  const CODE = RAW.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
  it('the shell body passes ITS scroll column (the same element the top bar knows) and the path to the hook', () => {
    expect(CODE).toMatch(/import \{ useShellListScrollMemory \} from '@\/hooks\/use-shell-list-scroll-memory';/);
    expect(CODE).toMatch(/const \{ setScrollContainer, scrollContainer \} = useTopBar\(\);/);
    expect(CODE).toMatch(/useShellListScrollMemory\(scrollContainer, usePathname\(\)\);/);
    expect(CODE).toMatch(/<div ref=\{setRef\} className="flex flex-1 min-h-0 flex-col overflow-y-auto">/);
  });
});
