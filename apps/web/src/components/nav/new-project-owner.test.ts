// @vitest-environment jsdom
// story 5031 (C1 step 5a-2) — the desktop app's «새 프로젝트» door (the window event · the ⌘N flag on the address) reaches exactly ONE of the mounted project switchers: the highest priority, ties → the last registered. Nothing registers in a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = Object.freeze({ inApp: true as const, device: { name: 'Mac' }, runtimes: [], pickFolder: vi.fn(async () => null), startHere: vi.fn(async () => ({ ok: true as const })), setProjectFolder: vi.fn(async () => ({ ok: true as const })) });
const inApp = () => { (window as unknown as { sprintableDesktop: unknown }).sprintableDesktop = bridge; };

beforeEach(() => { vi.resetModules(); });
afterEach(() => { delete (window as unknown as { sprintableDesktop?: unknown }).sprintableDesktop; window.history.replaceState(null, '', '/'); });

describe('new-project-owner — one owner per press', () => {
  it('⭐the event goes to the highest priority only (the order of registering does not matter), and to the next one when that one is gone', async () => {
    inApp();
    const { registerNewProjectOwner } = await import('./new-project-owner');
    const { OPEN_NEW_PROJECT_EVENT } = await import('./new-project-entry');
    const bar = vi.fn(); const column = vi.fn(); const popover = vi.fn();
    const offBar = registerNewProjectOwner(bar, 1);
    registerNewProjectOwner(column, 0);
    registerNewProjectOwner(popover, 0); // registered last, lower priority
    window.dispatchEvent(new Event(OPEN_NEW_PROJECT_EVENT));
    expect([bar.mock.calls.length, column.mock.calls.length, popover.mock.calls.length]).toEqual([1, 0, 0]);
    offBar();
    window.dispatchEvent(new Event(OPEN_NEW_PROJECT_EVENT));
    expect([bar.mock.calls.length, column.mock.calls.length, popover.mock.calls.length], 'equal priority: the last registered').toEqual([1, 0, 1]);
  });

  it('⭐the ⌘N flag goes to the owner once and is taken off the address', async () => {
    inApp();
    window.history.replaceState(null, '', '/dashboard?x=1&new_project=1#top');
    const { registerNewProjectOwner } = await import('./new-project-owner');
    const bar = vi.fn(); const column = vi.fn();
    registerNewProjectOwner(column, 0);
    registerNewProjectOwner(bar, 1);
    await Promise.resolve();
    expect([bar.mock.calls.length, column.mock.calls.length]).toEqual([1, 0]);
    expect(window.location.search + window.location.hash).toBe('?x=1#top');
  });

  it('a browser (no bridge) registers nothing: the event and the flag open nothing, the flag stays', async () => {
    window.history.replaceState(null, '', '/dashboard?new_project=1');
    const { registerNewProjectOwner, __newProjectOwnerCount } = await import('./new-project-owner');
    const { OPEN_NEW_PROJECT_EVENT } = await import('./new-project-entry');
    const open = vi.fn();
    registerNewProjectOwner(open, 1);
    window.dispatchEvent(new Event(OPEN_NEW_PROJECT_EVENT));
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
    expect(__newProjectOwnerCount()).toBe(0);
    expect(window.location.search).toBe('?new_project=1');
  });
});
