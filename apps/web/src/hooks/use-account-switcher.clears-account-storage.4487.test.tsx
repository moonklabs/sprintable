// @vitest-environment jsdom
//
// story #4487 — a sign-out (this · all), an account switch and adding an account clear the browser values that belong to the
// account (lib/browser-storage-keys.ts): the next account's screens and requests never carry the previous one's (the desktop
// setup's «결과 보기» took the previous account's project id). The device's view settings, theme and language stay. A switch or
// an add keeps the drafts (chat · field) so A → B → A does not lose what was being written; a sign-out clears them (PO 04:17Z).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import { useAccountSwitcher, type Account } from './use-account-switcher';
import { BROWSER_STORAGE_KEYS } from '@/lib/browser-storage-keys';
import { logoutUser } from '@/lib/db/client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const other: Account = { account_id: 'acc-2', name: 'B', email: 'b@x.test', org_name: 'O', avatar_url: null, status: 'inactive' };

function Harness() {
  const acc = useAccountSwitcher('나');
  return (
    <div>
      <button type="button" data-testid="switch" onClick={() => void acc.handleSwitch(other)}>switch</button>
      <button type="button" data-testid="add" onClick={() => void acc.handleAdd()}>add</button>
      <button type="button" data-testid="out-this" onClick={() => void acc.handleSignOut('this')}>this</button>
      <button type="button" data-testid="out-all" onClick={() => void acc.handleSignOut('all')}>all</button>
    </div>
  );
}

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

const sample = (e: (typeof BROWSER_STORAGE_KEYS)[number]) => (e.prefix ? `${e.key}x-1` : e.key);

// PO 03:13Z — written out here on purpose (not read from the list): a key moved to the wrong side of the list must fail.
// drafts — cleared on a sign-out only (PO 04:17Z · Yuna)
const DRAFTS: Array<['session' | 'local', string]> = [
  ['session', 'sprintable:field-draft:v1:doc:1:body'], ['local', 'sprintable:chat-draft:t-1'],
];
// cleared on a sign-out and on a switch / add
const MUST_CLEAR: Array<['session' | 'local', string]> = [
  ['session', 'sprintable_tab_project_id'], ['session', 'sp_onboarding_org_draft:u-1'], ['session', 'sprintable_desktop_setup_active'],
  ['session', 'sprintable_onboarding_session_id'], ['session', 'sprintable_pending_toast'], ['session', 'au-usage-warn-dismissed-band'],
  ['session', 'storage-capacity-toast-shown'], ['session', 'storage-capacity-warn-dismissed'],
  ['local', 'steer-recipients:p-1'], ['local', 'docs:recents:p-1'], ['local', 'sprintable_activation_checklist_complete:o-1'],
  ['local', 'sprintable:intent-suggestion:dismissed'], ['local', 'sprintable:reference-candidates:rejected'],
];
const MUST_KEEP: Array<['session' | 'local', string]> = [
  ['local', 'board_axis_mode_p-1'], ['local', 'done_collapsed_p-1'], ['local', 'wip_limit_p-1_todo'], ['local', 'epic_swimlane_axis_mode_p-1'],
  ['local', 'docs-sort-mode:p-1'], ['local', 'docs-view-mode:p-1'], ['local', 'docs:tree:expanded:p-1'], ['local', 'docs:policy-sprints-panel:p-1'],
  ['local', 'sidebar_width'], ['local', 'sidebar_group_collapsed'], ['local', 'docs-sidebar-collapsed'], ['local', 'sprintable-flow-canvas-lane-count'],
  ['local', 'team-presence'], ['local', 'storage-detail'], ['local', 'sprintable:refresh_interval_ms'], ['session', 'sp_reopen_once_url'],
  ['local', 'sprintable.releaseNotes.seen.u-1'], ['local', 'sprintable.billing.paymentAttempt:o-1'], ['local', 'theme'],
];
const store = (area: 'session' | 'local') => (area === 'session' ? window.sessionStorage : window.localStorage);

function seed() {
  for (const e of BROWSER_STORAGE_KEYS) store(e.area).setItem(sample(e), '1');
  for (const [area, k] of [...DRAFTS, ...MUST_CLEAR, ...MUST_KEEP]) store(area).setItem(k, '1');
  window.localStorage.setItem('theme', 'dark'); // next-themes — not ours, never touched
}

function expectOnlyAccountKeysGone(moment: 'signout' | 'switch') {
  for (const e of BROWSER_STORAGE_KEYS) {
    if (e.where.includes('lib/tab-owner.ts') && e.scope === 'kept') continue; // the owner keys are rewritten on purpose (story #4490, own test)
    const v = store(e.area).getItem(sample(e));
    if (e.scope === 'account' && (e.on as readonly string[]).includes(moment)) expect(v, `${e.area}:${sample(e)} should be cleared`).toBeNull();
    else expect(v, `${e.area}:${sample(e)} should stay`).toBe('1');
  }
  for (const [area, k] of DRAFTS) {
    if (moment === 'signout') expect(store(area).getItem(k), `${area}:${k} — a sign-out clears drafts (PO 04:17Z)`).toBeNull();
    else expect(store(area).getItem(k), `${area}:${k} — a switch / add keeps drafts (PO 04:17Z)`).toBe('1');
  }
  for (const [area, k] of MUST_CLEAR) expect(store(area).getItem(k), `${area}:${k} must be cleared (PO 03:13Z)`).toBeNull();
  for (const [area, k] of MUST_KEEP) expect(store(area).getItem(k), `${area}:${k} must stay (PO 03:13Z)`).not.toBeNull();
  expect(window.localStorage.getItem('theme')).toBe('dark');
}

async function press(id: string) {
  await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(); });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

beforeEach(async () => {
  Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
  seed();
  vi.stubGlobal('location', { ...window.location, assign: () => {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Harness /></NextIntlClientProvider>);
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function answer(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

describe('[SID:4487] the account\'s browser values go with the account', () => {
  it.each([
    ['an account switch', 'switch', { data: { ok: true } }, 'switch'],
    ['adding an account', 'add', { data: { redirect: '/login' } }, 'switch'],
    ['«log out only this account» (another stays)', 'out-this', { data: { next: 'acc-2' } }, 'signout'],
    ['a full logout', 'out-all', { data: { next: null } }, 'signout'],
  ] as const)('%s clears the account\'s keys (drafts only on a sign-out) · keeps view settings, layout, theme', async (_name, id, body, moment) => {
    answer(body);
    await press(id);
    expectOnlyAccountKeysGone(moment);
  });

  it('a sign-out that fails still clears everything, drafts too (it goes to /login)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await press('out-all');
    expectOnlyAccountKeysGone('signout');
  });

  it('a store that cannot be listed never stops the sign-out (it still goes to /login)', async () => {
    const broken = { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => { throw new Error('blocked'); }, get length(): number { throw new Error('blocked'); } };
    Object.defineProperty(window, 'localStorage', { value: broken, configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: broken, configurable: true });
    const went: string[] = [];
    vi.stubGlobal('location', { ...window.location, assign: (u: string) => went.push(u) });
    answer({ data: { next: null } });
    await press('out-all');
    expect(went).toEqual(['/login']);
  });

  it('a logout through logoutUser (session expiry paths) clears them too', async () => {
    answer({});
    await logoutUser('rt');
    expectOnlyAccountKeysGone('signout');
  });
});
