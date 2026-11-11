// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings › 프로젝트 접근 · piece ⑤c) — the REQUESTS the project-access list and the add-member dialog send are the old ones. This file only watches what leaves the browser (url · method · body) with selectors that fit the old
// markup and the new, so it is run on the old components (origin/develop) and on the ds ones and must be green on both — the move changed the parts, not the permission-bearing calls (grant · revoke · invite).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ProjectAccessSection } from './project-access-section';
import { AddMemberModal } from './add-member-modal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; method: string; body?: unknown }[];
let grants: { id: string; org_member_id: string; role: string }[];

beforeEach(() => {
  calls = [];
  grants = [{ id: 'g-admin', org_member_id: 'm-admin', role: 'admin' }];
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
    if (url === '/api/projects/p-1/access-candidates') {
      return json([
        { id: 'm-owner', user_id: 'u-o', name: '오너', email: 'o@x.com', role: 'owner' },
        { id: 'm-admin', user_id: 'u-a', name: '관리자', email: 'a@x.com', role: 'admin' },
        { id: 'm-member', user_id: 'u-m', name: '구성원', email: 'm@x.com', role: 'member' },
      ]);
    }
    if (url === '/api/projects/p-1/access' && method === 'POST') return json({}, 201);
    if (url.startsWith('/api/projects/p-1/access/') && method === 'DELETE') return json({});
    if (url === '/api/projects/p-1/access') return json(grants);
    if (url === '/api/organizations/org-1/invites' && method === 'POST') return json({ invite_url: 'https://app.test/invite/x' });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const wrap = (ui: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{ui}</NextIntlClientProvider>;
const sent = () => calls.filter((c) => c.method !== 'GET').map(({ url, method, body }) => ({ url, method, body }));
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const buttonWithText = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const T = koMessages.settings;

describe('[SID:4891] the project-access list sends the same requests (old and ds markup)', () => {
  async function draw() { await act(async () => { root.render(wrap(<ProjectAccessSection projectId="p-1" />)); }); await flush(); }

  it('allowing a blocked member: one POST with that member and their org role; blocking a granted member: one DELETE of that grant', async () => {
    await draw();
    await click(buttonWithText(container, T.projectAccessBlocked));
    await click(buttonWithText(container, T.projectAccessAllowed));
    expect(sent()).toEqual([
      { url: '/api/projects/p-1/access', method: 'POST', body: { org_member_id: 'm-member', role: 'member' } },
      { url: '/api/projects/p-1/access/g-admin', method: 'DELETE', body: undefined },
    ]);
  });

  it('the org owner has no toggle (always allowed) — only the two others do', async () => {
    await draw();
    const toggles = [...container.querySelectorAll('button')].filter((b) => [T.projectAccessAllowed, T.projectAccessBlocked].includes(b.textContent?.trim() ?? ''));
    expect(toggles).toHaveLength(2);
    expect(container.textContent).toContain('오너');
  });
});

describe('[SID:4891] the add-member dialog sends the same invite (old and ds markup)', () => {
  const projects = [{ id: 'p-1', name: '프로젝트 하나' }, { id: 'p-2', name: '프로젝트 둘' }];
  async function drawModal() {
    await act(async () => { root.render(wrap(<AddMemberModal open onClose={() => {}} orgId="org-1" projects={projects} onAdded={() => {}} />)); });
    await flush();
  }
  const submit = () => [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === T.addMember).pop()!;

  it('POST {email trimmed · chosen role · chosen projects} — admin role, second project picked, first picked then un-picked', async () => {
    await drawModal();
    const email = document.body.querySelector('input[type="email"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(email, '  new@x.com '); email.dispatchEvent(new Event('input', { bubbles: true })); });
    // the old dialog chose the role in a menu part (no <select>), so on the old component only the default role is sent; the ds dialog has a native select and the admin choice is checked
    const role = document.body.querySelector('select') as HTMLSelectElement | null;
    if (role) await act(async () => { role.value = 'admin'; role.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(buttonWithText(document.body, '프로젝트 둘'));
    await click(buttonWithText(document.body, '프로젝트 하나'));
    await click(buttonWithText(document.body, '프로젝트 하나'));
    await click(submit());
    expect(sent()).toEqual([
      { url: '/api/organizations/org-1/invites', method: 'POST', body: { email: 'new@x.com', role: role ? 'admin' : 'member', project_ids: ['p-2'] } },
    ]);
  });

  it('an empty email sends nothing and says so', async () => {
    await drawModal();
    await click(submit());
    expect(sent()).toEqual([]);
    expect(document.body.textContent).toContain(T.inviteEmailRequired);
  });
});
