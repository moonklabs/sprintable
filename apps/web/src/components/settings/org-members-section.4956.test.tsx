// @vitest-environment jsdom
//
// story 4956 (desktop hands · 구성원 화면) — a member row's right-click menu holds the ONE existing action of the row, «제거». It is the same handler the row's button has (→ the confirm dialog «되돌릴 수 없어요»); the menu itself removes nothing.
// The owner and yourself have no removable row (`canEdit` false · an invisible placeholder button) and so no menu. The item reads like the board card / goal row menu: the normal text colour, a warning tint only on hover / highlight.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { OrgMembersSection } from './org-members-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; method: string }[];
const t = koMessages.settings;

const MEMBERS = [
  { id: 'row-owner', user_id: 'u-owner', name: '오너', email: 'owner@x.com', role: 'owner', created_at: '2026-10-01T00:00:00Z' },
  { id: 'row-self', user_id: 'u-self', name: '나', email: 'me@x.com', role: 'admin', created_at: '2026-10-02T00:00:00Z' },
  { id: 'row-other', user_id: 'u-other', name: '다른 사람', email: 'other@x.com', role: 'member', created_at: '2026-10-03T00:00:00Z' },
];

beforeEach(() => {
  calls = [];
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const ok = (data: unknown) => ({ ok: true, json: async () => data });
    if (url === '/api/me') return ok({ data: { user_id: 'u-self' } });
    if (url === '/api/org-members' && method === 'GET') return ok({ data: MEMBERS });
    if (url === '/api/organizations/org-1/invites' && method === 'GET') return ok({ data: [] });
    if (url === '/api/projects') return ok({ data: [] });
    if (url === '/api/org-members/row-other/affected-projects') return ok({ data: [] });
    if (method === 'DELETE') return ok({ data: {} });
    throw new Error('unexpected fetch: ' + url);
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
async function draw() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrgMembersSection orgId="org-1" currentRole="admin" /></NextIntlClientProvider>); });
  await flush();
}
const rowOf = (email: string) => [...container.querySelectorAll<HTMLElement>('.divide-y > div')].find((d) => d.textContent?.includes(email))!;
const rightClick = async (el: HTMLElement) => { await act(async () => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 80 })); }); await flush(); };
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

describe('[SID:4956] a member row\'s right-click menu', () => {
  it('⭐a removable row: right-click shows the one item «제거» (normal text colour · a warning tint on hover) and removes nothing; pressing it opens the same confirm dialog', async () => {
    await draw();
    await rightClick(rowOf('other@x.com'));
    expect(items().map((i) => i.textContent?.trim())).toEqual([t.removeFromProject]); // reverted (no menu) → RED
    const item = items()[0]!;
    expect(item.className).toContain('hover:bg-destructive-tint');
    expect(item.className).not.toContain('text-ds-failed'); // never a red label
    expect(calls.some((c) => c.method === 'DELETE'), 'the menu removes nothing').toBe(false);
    await act(async () => { item.click(); }); await flush();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog, 'the confirm dialog').toBeTruthy();
    expect(dialog.textContent).toContain(koMessages.settings.removeMemberIrreversible);
    expect(calls.some((c) => c.method === 'DELETE'), 'still nothing removed before the confirmation').toBe(false);
  });

  it('⭐the owner row and your own row have no menu (nothing to remove there — the invisible placeholder stands in the button\'s place)', async () => {
    await draw();
    await rightClick(rowOf('owner@x.com'));
    expect(items()).toHaveLength(0);
    await rightClick(rowOf('me@x.com'));
    expect(items()).toHaveLength(0);
  });
});
