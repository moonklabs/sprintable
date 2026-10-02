// @vitest-environment jsdom
//
// story #4490 — a user can change without a sign-out (the session expires · a server redirect · an expired account in the
// switcher · adding an account fails with 401 · the next person signs in after the last session ran out). The signed-in
// screens check this browser's owner on their first render (TabOwnerGate → claimTabOwner) and clear the previous person's
// values; drafts carry their owner in the key (PO 05:00Z ①–⑥ · 05:03Z).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TabOwnerGate } from '@/components/auth/tab-owner-gate';
import { clearAccountScopedStorage } from './browser-storage-keys';
import {
  OWNER_HANDOFF_KEY,
  OWNER_HANDOFF_TTL_MS,
  TAB_OWNER_KEY,
  claimTabOwner,
  draftOwnerSegment,
  handOwnerTo,
  markIntendedSwitch,
} from './tab-owner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;
const chatDraft = (thread: string) => `sprintable:chat-draft:${draftOwnerSegment('local')}${thread}`;
const fieldDraft = (rest: string) => `sprintable:field-draft:v1:${draftOwnerSegment('session')}${rest}`;
const T0 = 1_790_000_000_000;

/** User A has been working here: owner A in both stores, an account value in each, a draft in each, a device setting. */
function seedA() {
  local().setItem(TAB_OWNER_KEY, 'A');
  session().setItem(TAB_OWNER_KEY, 'A');
  session().setItem('sprintable_tab_project_id', 'proj-of-A');
  local().setItem('docs:recents:p-1', '["doc-of-A"]');
  local().setItem(chatDraft('t-1'), 'A is writing');
  session().setItem(fieldDraft('goal-create:new:description'), 'A field draft');
  local().setItem('board_axis_mode_p-1', 'status');
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
});

describe('[SID:4490] the browser owner', () => {
  it('session ran out → B signs in (no sign-out passed): A\'s values and drafts are gone · device settings stay', () => {
    seedA();
    claimTabOwner('B', T0);
    expect(session().getItem('sprintable_tab_project_id')).toBeNull();
    expect(local().getItem('docs:recents:p-1')).toBeNull();
    expect(local().getItem('sprintable:chat-draft:u:A:t-1')).toBeNull();
    expect(session().getItem('sprintable:field-draft:v1:u:A:goal-create:new:description')).toBeNull();
    expect(local().getItem('board_axis_mode_p-1')).toBe('status');
    expect([local().getItem(TAB_OWNER_KEY), session().getItem(TAB_OWNER_KEY)]).toEqual(['B', 'B']);
  });

  it('A → B by the switcher: B never sees A\'s draft · back to A: it is there again', () => {
    seedA();
    clearAccountScopedStorage('switch');
    handOwnerTo('B');
    claimTabOwner('B', T0); // B's first screen
    expect(local().getItem(chatDraft('t-1'))).toBeNull(); // B's key for the same conversation
    expect(session().getItem(fieldDraft('goal-create:new:description'))).toBeNull();
    expect(session().getItem('sprintable_tab_project_id')).toBeNull(); // the 4487 bug stays closed

    clearAccountScopedStorage('switch');
    handOwnerTo('A');
    claimTabOwner('A', T0);
    expect(local().getItem(chatDraft('t-1'))).toBe('A is writing');
    expect(session().getItem(fieldDraft('goal-create:new:description'))).toBe('A field draft');
  });

  it('the same person signs in again: everything stays, drafts too', () => {
    seedA();
    claimTabOwner('A', T0);
    expect(session().getItem('sprintable_tab_project_id')).toBe('proj-of-A');
    expect(local().getItem('docs:recents:p-1')).toBe('["doc-of-A"]');
    expect(local().getItem(chatDraft('t-1'))).toBe('A is writing');
    expect(local().getItem('board_axis_mode_p-1')).toBe('status');
  });

  it('«add an account» left its mark → the next sign-in within 10 minutes is a switch (A\'s drafts kept for A) · the mark is gone after one read', () => {
    seedA();
    clearAccountScopedStorage('switch');
    markIntendedSwitch(T0);
    claimTabOwner('B', T0 + 60_000);
    expect(local().getItem('sprintable:chat-draft:u:A:t-1')).toBe('A is writing');
    expect(session().getItem('sprintable_tab_project_id')).toBeNull();
    expect(local().getItem(OWNER_HANDOFF_KEY)).toBeNull();
  });

  it('a mark older than 10 minutes (an add never finished) → a later stranger\'s sign-in is a sign-out: A\'s drafts gone (PO 05:03Z)', () => {
    seedA();
    markIntendedSwitch(T0);
    claimTabOwner('B', T0 + OWNER_HANDOFF_TTL_MS + 1);
    expect(local().getItem('sprintable:chat-draft:u:A:t-1')).toBeNull();
    expect(session().getItem('sprintable:field-draft:v1:u:A:goal-create:new:description')).toBeNull();
    expect(local().getItem(OWNER_HANDOFF_KEY)).toBeNull();
  });

  it('a mark is used once: after it served one owner change, the next change is a sign-out again', () => {
    seedA();
    markIntendedSwitch(T0);
    claimTabOwner('B', T0 + 1000);
    local().setItem(chatDraft('t-2'), 'B is writing');
    claimTabOwner('C', T0 + 2000);
    expect(local().getItem('sprintable:chat-draft:u:B:t-2')).toBeNull();
  });

  it('drafts written before this story (no owner in the key) are adopted, never dropped: by the same person · by the previous owner', () => {
    local().setItem('sprintable:chat-draft:t-9', 'old draft');
    session().setItem('sprintable:field-draft:v1:goal-create:new:description', 'old field');
    claimTabOwner('A', T0); // no owner known yet → the signed-in person
    expect(local().getItem('sprintable:chat-draft:u:A:t-9')).toBe('old draft');
    expect(session().getItem('sprintable:field-draft:v1:u:A:goal-create:new:description')).toBe('old field');
    expect(local().getItem('sprintable:chat-draft:t-9')).toBeNull();

    local().setItem('sprintable:chat-draft:t-8', 'older, A\'s');
    markIntendedSwitch(T0);
    claimTabOwner('B', T0 + 1000); // an intended switch: the ownerless draft goes to A (the previous owner), not to B
    expect(local().getItem('sprintable:chat-draft:u:A:t-8')).toBe('older, A\'s');
    expect(local().getItem('sprintable:chat-draft:u:B:t-8')).toBeNull();
  });

  it('each store is checked on its own: a tab still holding A\'s session values is cleaned even when the browser already belongs to B', () => {
    local().setItem(TAB_OWNER_KEY, 'B');
    session().setItem(TAB_OWNER_KEY, 'A');
    session().setItem('sprintable_tab_project_id', 'proj-of-A');
    local().setItem('docs:recents:p-1', '["doc-of-B"]');
    claimTabOwner('B', T0);
    expect(session().getItem('sprintable_tab_project_id')).toBeNull();
    expect(local().getItem('docs:recents:p-1')).toBe('["doc-of-B"]');
  });
});

describe('[SID:4490] TabOwnerGate runs before anything below it reads storage (PO 05:00Z ①)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('a child reading A\'s tab project in its first render and in its effect sees nothing once B is the user', async () => {
    seedA();
    const seen: Array<string | null> = [];
    function Child() {
      const [atRender] = useState(() => window.sessionStorage.getItem('sprintable_tab_project_id'));
      useEffect(() => { seen.push(window.sessionStorage.getItem('sprintable_tab_project_id')); }, []);
      seen.push(atRender);
      return null;
    }
    await act(async () => { root.render(<TabOwnerGate userId="B"><Child /></TabOwnerGate>); });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === null)).toBe(true);
  });

  it('no user (a page that renders without a session) → nothing is touched', async () => {
    seedA();
    await act(async () => { root.render(<TabOwnerGate userId={null}><div /></TabOwnerGate>); });
    expect(session().getItem('sprintable_tab_project_id')).toBe('proj-of-A');
  });
});
