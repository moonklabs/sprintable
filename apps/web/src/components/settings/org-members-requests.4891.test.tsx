// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings › 조직 구성원 · piece ⑤b) — the REQUESTS the members section sends are the old ones: this file only watches what leaves the browser (url · method · body), with selectors that fit the old markup and the new,
// so it is run on the old component (origin/develop) and on the ds one and must be green on both — the move changed the parts, not the permission-bearing calls (change a role · remove a member · invite).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { OrgMembersSection } from './org-members-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; method: string; body?: unknown }[];

const MEMBERS = [
  { id: 'row-owner', user_id: 'u-owner', name: '오너', email: 'owner@x.com', role: 'owner', created_at: '2026-10-01T00:00:00Z' },
  { id: 'row-self', user_id: 'u-self', name: '나', email: 'me@x.com', role: 'admin', created_at: '2026-10-02T00:00:00Z' },
  { id: 'row-other', user_id: 'u-other', name: '다른 사람', email: 'other@x.com', role: 'member', created_at: '2026-10-03T00:00:00Z' },
  { id: 'row-admin2', user_id: 'u-admin2', name: '또 다른 관리자', email: 'admin2@x.com', role: 'admin', created_at: '2026-10-04T00:00:00Z' },
];

beforeEach(() => {
  calls = [];
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (data: unknown) => ({ ok: true, json: async () => data });
    if (url === '/api/me') return ok({ data: { user_id: 'u-self' } });
    if (url === '/api/org-members' && method === 'GET') return ok({ data: MEMBERS });
    if (url === '/api/organizations/org-1/invites' && method === 'GET') return ok({ data: [] });
    if (url === '/api/projects') return ok({ data: [] });
    if (url.endsWith('/affected-projects')) return ok({ data: [] });
    return ok({ data: { invite_url: 'https://app.test/invite/new' } });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
async function draw() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrgMembersSection orgId="org-1" currentRole="admin" /></NextIntlClientProvider>); });
  await flush();
}
const sent = () => calls.filter((c) => c.method !== 'GET').map(({ url, method, body }) => ({ url, method, body }));

describe('[SID:4891] the members section sends the same requests (old and ds markup)', () => {
  it('changing a role: one PATCH to that member with exactly the chosen role (member → admin, admin → member)', async () => {
    await draw();
    const rowSelects = [...container.querySelectorAll('.divide-y select')] as HTMLSelectElement[];
    expect(rowSelects).toHaveLength(2); // the member and the other admin — never the owner, never me
    for (const [el, value] of [[rowSelects[0]!, 'admin'], [rowSelects[1]!, 'member']] as const) {
      await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
      await flush();
    }
    expect(sent()).toEqual([
      { url: '/api/org-members/row-other', method: 'PATCH', body: { role: 'admin' } },
      { url: '/api/org-members/row-admin2', method: 'PATCH', body: { role: 'member' } },
    ]);
  });

  it('removing: asks first (nothing sent), then one DELETE to that member', async () => {
    await draw();
    const removeBtns = [...container.querySelectorAll('.divide-y button')].filter((b) => b.textContent === koMessages.settings.removeFromProject && b.getAttribute('aria-hidden') !== 'true') as HTMLButtonElement[];
    expect(removeBtns).toHaveLength(2);
    await act(async () => { removeBtns[0]!.click(); }); await flush();
    expect(sent()).toEqual([]);
    expect(document.body.textContent).toContain('다른 사람');
    const dialogBtns = [...document.querySelectorAll('[role="dialog"] button')];
    await act(async () => { (dialogBtns.find((b) => b.textContent === koMessages.settings.removeFromProject) as HTMLButtonElement).click(); }); await flush();
    expect(sent()).toEqual([{ url: '/api/org-members/row-other', method: 'DELETE', body: undefined }]);
  });

  it('inviting: one POST with the typed email, the default role «member» and no projects; the form empties', async () => {
    await draw();
    const email = [...container.querySelectorAll('input')].find((i) => i.placeholder === 'email@example.com') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(email, 'new@x.com'); email.dispatchEvent(new Event('input', { bubbles: true })); });
    const invite = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.settings.invite) as HTMLButtonElement;
    await act(async () => { invite.click(); }); await flush();
    expect(sent()).toEqual([{ url: '/api/organizations/org-1/invites', method: 'POST', body: { email: 'new@x.com', role: 'member', project_ids: [] } }]);
    expect(email.value).toBe('');
  });
});
