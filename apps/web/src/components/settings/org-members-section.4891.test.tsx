// @vitest-environment jsdom
//
// story 4891 (UI-8 · settings › 조직 구성원 · piece ⑤b) — the members section and the remove dialog on ds parts: what the list rows, the invite form, the project picker, the pending-invite rows and the remove dialog DO (the same requests, the same bodies,
// the same fixed words) — plus what the ds parts add: the row's role select has a name, the picker keeps aria-expanded / aria-pressed, the dialog is a ds dialog with the focus on «취소».
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
const t = koMessages.settings;

const MEMBERS = [
  { id: 'row-owner', user_id: 'u-owner', name: '오너', email: 'owner@x.com', role: 'owner', created_at: '2026-10-01T00:00:00Z' },
  { id: 'row-self', user_id: 'u-self', name: '나', email: 'me@x.com', role: 'admin', created_at: '2026-10-02T00:00:00Z' },
  { id: 'row-other', user_id: 'u-other', name: '다른 사람', email: 'other@x.com', role: 'member', created_at: '2026-10-03T00:00:00Z' },
  { id: 'row-admin2', user_id: 'u-admin2', name: '또 다른 관리자', email: 'admin2@x.com', role: 'admin', created_at: '2026-10-04T00:00:00Z' },
];
const INVITES = [{ id: 'inv-1', email: 'pending@x.com', role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z', invite_url: 'https://app.test/invite/abc' }];

beforeEach(() => {
  calls = [];
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (data: unknown) => ({ ok: true, json: async () => data });
    if (url === '/api/me') return ok({ data: { user_id: 'u-self' } });
    if (url === '/api/org-members' && method === 'GET') return ok({ data: MEMBERS });
    if (url === '/api/organizations/org-1/invites' && method === 'GET') return ok({ data: INVITES });
    if (url === '/api/projects') return ok({ data: [{ id: 'p1', name: '알파' }, { id: 'p2', name: '베타' }] });
    if (url === '/api/org-members/row-other/affected-projects') return ok({ data: [{ project_id: 'p1', project_name: '알파', role: 'member' }] });
    if (method === 'POST' || method === 'PATCH' || method === 'DELETE') return ok({ data: { invite_url: 'https://app.test/invite/new' } });
    throw new Error('unexpected fetch: ' + url);
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
async function draw() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrgMembersSection orgId="org-1" currentRole="admin" /></NextIntlClientProvider>); });
  await flush();
}
const press = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const btn = (re: RegExp | string, scope: ParentNode = container) => [...scope.querySelectorAll('button')].find((b) => (typeof re === 'string' ? b.textContent === re : re.test(b.textContent ?? ''))) as HTMLButtonElement | undefined;
const choose = async (el: HTMLSelectElement, v: string) => { await act(async () => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }); await flush(); };
const typeInto = async (el: HTMLInputElement, v: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }); };

describe('[SID:4891] OrgMembersSection on ds parts', () => {
  it('the cards are ds cards; the list header is the title + a ds CountBadge; owner/self rows show a tag and an invisible, aria-hidden placeholder where the remove button would be; only the other member has a (named) role select', async () => {
    await draw();
    expect(container.querySelectorAll('[data-slot="ds-card"]').length).toBeGreaterThanOrEqual(3);
    const listHead = [...container.querySelectorAll('h2')].find((h) => h.querySelector('[data-slot="ds-count-badge"]'))!;
    expect(listHead.textContent).toContain(t.orgMembersListHeading);
    const rows = container.querySelectorAll('.divide-y > div');
    expect(rows.length).toBeGreaterThanOrEqual(5); // 4 members + 1 invite
    const selects = [...container.querySelectorAll('.divide-y select')] as HTMLSelectElement[];
    expect(selects).toHaveLength(2); // the member and the other admin (not the owner, not me)
    expect(selects.map((x) => x.getAttribute('aria-label'))).toEqual(['다른 사람 (other@x.com)', '또 다른 관리자 (admin2@x.com)']); // name + address: two people with the same display name are still told apart
    expect([...selects[0]!.options].map((o) => o.value)).toEqual(['admin', 'member']);
    const hidden = [...container.querySelectorAll('button[aria-hidden="true"]')];
    expect(hidden).toHaveLength(2);
    expect(hidden.every((h) => h.className.includes('invisible') && h.getAttribute('tabindex') === '-1')).toBe(true);
  });

  it('changing the role PATCHes THAT member with exactly the chosen role (member → admin, and admin → member — not a fixed value)', async () => {
    await draw();
    const [other, admin2] = [...container.querySelectorAll('.divide-y select')] as HTMLSelectElement[];
    await choose(other!, 'admin');
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([{ url: '/api/org-members/row-other', method: 'PATCH', body: { role: 'admin' } }]);
    expect(container.querySelector('[data-slot="ds-banner"]')?.textContent).toContain(t.orgMemberRoleChangeSuccess);
    await choose(admin2!, 'member');
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)).toEqual({ url: '/api/org-members/row-admin2', method: 'PATCH', body: { role: 'member' } });
  });

  it('the invite: email + the chosen role + the picked projects go into the POST; the picker trigger keeps aria-expanded and each project aria-pressed', async () => {
    await draw();
    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    await typeInto(email, 'new@x.com');
    expect(email.getAttribute('aria-label')).toBe(koMessages.settings.profileEmail); // named by its purpose, in the UI language (not the sample address)
    await choose(container.querySelector('select[aria-label]:not(.divide-y select)') as HTMLSelectElement, 'admin');
    const trigger = container.querySelector('[aria-expanded]') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await press(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const alpha = btn('알파')!;
    expect(alpha.getAttribute('aria-pressed')).toBe('false');
    await press(alpha);
    expect(alpha.getAttribute('aria-pressed')).toBe('true');
    await press(btn(t.invite));
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/invites'))?.body).toEqual({ email: 'new@x.com', role: 'admin', project_ids: ['p1'] });
    expect(container.querySelector('[data-slot="ds-banner"]')?.getAttribute('role')).toBe('status'); // saved = status
    expect((container.querySelector('input[type="email"]') as HTMLInputElement).value).toBe(''); // the form is emptied
  });

  it('removing: [제거] opens the ds dialog naming the member, the focus is on «취소», confirm sends DELETE and the dialog closes; cancel sends nothing', async () => {
    await draw();
    const remove = [...container.querySelectorAll('.divide-y button:not([aria-hidden])')].find((b) => b.textContent === t.removeFromProject) as HTMLButtonElement;
    await press(remove);
    const dlg = document.querySelector('[data-slot="ds-dialog-content"]')!;
    expect(dlg).toBeTruthy();
    expect(dlg.textContent).toContain('다른 사람');
    expect(dlg.textContent).toContain('알파'); // the affected project is listed
    expect(document.activeElement?.textContent).toBe(koMessages.common.cancel);
    await press(btn(koMessages.common.cancel, dlg));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await press(remove);
    await press(btn(t.removeFromProject, document.querySelector('[data-slot="ds-dialog-content"]')!));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/org-members/row-other');
    expect(document.querySelector('[data-slot="ds-dialog-content"]')).toBeNull();
  });

  it('a pending invite: copy · resend · cancel each carry the numbered name and reach their request; cancel is the ds danger button', async () => {
    const copied = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } });
    await draw();
    const copy = container.querySelector('button[aria-label*="1"][title]') as HTMLButtonElement;
    expect(copy.getAttribute('aria-label')).toContain('1');
    const resend = btn(t.resend)!;
    await press(resend);
    expect(calls.find((c) => c.url.endsWith('/resend'))?.method).toBe('POST');
    const revoke = [...container.querySelectorAll('.divide-y button')].find((b) => b.textContent === koMessages.common.cancel) as HTMLButtonElement;
    expect(revoke.className).toContain('border-ds-failed');
    await press(revoke);
    expect(calls.find((c) => c.method === 'DELETE' && c.url.endsWith('/invites/inv-1'))).toBeTruthy();
  });

  it('two members with the SAME display name get different select names (the address tells them apart)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const ok = (data: unknown) => ({ ok: true, json: async () => data });
      if (url === '/api/me') return ok({ data: { user_id: 'u-self' } });
      if (url === '/api/org-members' && method === 'GET') return ok({ data: [
        { id: 'a', user_id: 'ua', name: '김지우', email: 'a@x.com', role: 'member', created_at: '2026-10-01T00:00:00Z' },
        { id: 'b', user_id: 'ub', name: '김지우', email: 'b@x.com', role: 'member', created_at: '2026-10-02T00:00:00Z' },
      ] });
      if (url.endsWith('/invites') && method === 'GET') return ok({ data: [] });
      if (url === '/api/projects') return ok({ data: [] });
      throw new Error('unexpected fetch: ' + url);
    });
    await draw();
    const names = [...container.querySelectorAll('.divide-y select')].map((x) => x.getAttribute('aria-label'));
    expect(names).toEqual(['김지우 (a@x.com)', '김지우 (b@x.com)']);
  });

  it('a failed copy: the raw address is shown in a READ-ONLY field that selects itself on focus, with the touch floor, and the failure is said in an alert', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    await draw();
    await press(container.querySelector('button[aria-label*="1"][title]'));
    const raw = document.querySelector('[data-testid="org-members-copy-failed-raw-invite-url"]') as HTMLInputElement;
    expect(raw).toBeTruthy();
    expect(raw.readOnly).toBe(true);
    expect(raw.value).toBe('https://app.test/invite/abc');
    const select = vi.spyOn(raw, 'select');
    await act(async () => { raw.dispatchEvent(new FocusEvent('focus')); raw.focus(); });
    expect(select).toHaveBeenCalled();
    expect(container.querySelector('[data-slot="ds-banner"][role="alert"]')).toBeTruthy();
  });

  it('the invite role select lists «구성원» first (the default) and then «관리자»', async () => {
    await draw();
    const inviteRole = container.querySelector('select[aria-label*="/"]') as HTMLSelectElement;
    expect([...inviteRole.options].map((o) => o.value)).toEqual(['member', 'admin']);
    expect(inviteRole.value).toBe('member');
  });

  it('the remove dialog holds [제거] while the affected projects are read and when that read fails (confirm is enabled only with a readable answer)', async () => {
    const original = (fetch as unknown as ReturnType<typeof vi.fn>).getMockImplementation() as (u: string, i?: RequestInit) => Promise<unknown>;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/org-members/row-other/affected-projects') { await gate; return { ok: false, json: async () => ({}) }; }
      return original(url, init);
    });
    await draw();
    const remove = [...container.querySelectorAll('.divide-y button:not([aria-hidden])')].find((b) => b.textContent === t.removeFromProject) as HTMLButtonElement;
    await press(remove);
    const confirm = () => btn(t.removeFromProject, document.querySelector('[data-slot="ds-dialog-content"]')!)!;
    expect(confirm().disabled).toBe(true); // still reading
    expect(document.querySelector('[data-slot="ds-skeleton-group"]')).toBeTruthy();
    await act(async () => { release(); }); await flush();
    expect(document.querySelector('[data-slot="ds-dialog-content"] [role="alert"]')).toBeTruthy(); // the read failed → said as such
    expect(confirm().disabled).toBe(true); // …and still held
  });

  it('two identical copy failures in a row are announced twice (the banner is a new element each time)', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    await draw();
    const copy = () => container.querySelector('button[aria-label*="1"][title]');
    await press(copy());
    const first = container.querySelector('[data-slot="ds-banner"][role="alert"]');
    expect(first).toBeTruthy();
    await press(copy());
    const second = container.querySelector('[data-slot="ds-banner"][role="alert"]');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});
