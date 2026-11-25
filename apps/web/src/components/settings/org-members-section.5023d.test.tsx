// @vitest-environment jsdom
//
// story 5023 (d) — on a workspace server (no mail) an OWNER hands a member who forgot their password a reset link: the button appears only on the rows the SERVER says may get one, pressing it asks the server and shows the link
// in a dialog (a secret for 30 minutes — the person chooses the new password), and the refusals are said in plain words. Mounted for real, same harness as the 5023 invitation test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { OrgMembersSection } from './org-members-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const URL_ = 'https://team.example.com/reset-password?token=SECRET-TOKEN-VALUE';
let container: HTMLDivElement;
let root: Root;
let members: Array<Record<string, unknown>>;
let resetAnswer: { status: number; body: unknown };
let posts: string[];
let copied: string | null;
const row = (id: string, name: string, role: string, available?: boolean) => ({ id, user_id: `u-${id}`, name, email: `${id}@x.com`, role, created_at: '2026-10-01T00:00:00Z', ...(available === undefined ? {} : { password_reset_link_available: available }) });

beforeEach(() => {
  posts = []; copied = null;
  members = [row('owner', '오너', 'owner', false), row('plain', '평범', 'member', true), row('other', '다른조직', 'member', false), row('admin', '관리', 'admin', true), row('old', '옛서버', 'member')];
  resetAnswer = { status: 200, body: { reset_url: URL_, expires_in_seconds: 1800 } };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (t: string) => { copied = t; }) } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (url === '/api/me') return ok({ data: { user_id: 'u-owner' } });
    if (url === '/api/org-members' && method === 'GET') return ok({ data: members });
    if (url === '/api/organizations/org-1/invites' && method === 'GET') return ok({ data: [] });
    if (url === '/api/projects') return ok({ data: [] });
    const m = /^\/api\/org-members\/([^/]+)\/password-reset-link$/.exec(url);
    if (m && method === 'POST') { posts.push(m[1] as string); return { ok: resetAnswer.status === 200, status: resetAnswer.status, json: async () => resetAnswer.body }; }
    throw new Error('unexpected fetch: ' + url);
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
async function draw(locale: 'ko' | 'en' = 'ko') {
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><OrgMembersSection orgId="org-1" currentRole="owner" /></NextIntlClientProvider>); });
  await flush();
}
const press = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const buttons = () => [...container.querySelectorAll('[data-testid="org-member-reset-link"]')];
const dialog = () => document.querySelector('[data-testid="reset-link-dialog"]');
const banner = () => container.querySelector('[data-slot="ds-banner"]')?.textContent ?? '';

describe('the button is the server\'s word', () => {
  it('only the rows the server marked (password_reset_link_available: true) get a button — not the owner, not a person of another organization, not a row of an older server that does not say', async () => {
    await draw();
    expect(buttons()).toHaveLength(2);
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual([`2번째 구성원 ${koMessages.settings.orgMemberResetLink}`, `4번째 구성원 ${koMessages.settings.orgMemberResetLink}`]);
    expect(buttons()[0]?.textContent).toBe('비밀번호 초기화 링크');
  });
  it('a server that offers it to nobody (hosted · the desktop app · an admin asking): no button, no dialog', async () => {
    members = members.map((m) => ({ ...m, password_reset_link_available: false }));
    await draw();
    expect(buttons()).toHaveLength(0); expect(dialog()).toBeNull();
  });
});

describe('pressing it', () => {
  it('asks the server for THAT member, once, and shows the link in a dialog with who it is for, how long it lasts and that they choose the password', async () => {
    await draw();
    await press(buttons()[0]);
    expect(posts).toEqual(['plain']);
    const d = dialog()!; expect(d).toBeTruthy();
    expect((document.querySelector('[data-testid="reset-link-url"]') as HTMLInputElement).value).toBe(URL_);
    expect(d.querySelector('[data-slot="ds-dialog-description"]')?.textContent).toBe('평범 (plain@x.com)'); // who it is for — in the header, apart from the sentence below
    expect(d.textContent).toContain('30분'); expect(d.textContent).toContain('새 비밀번호를 직접 정해요'); expect(d.textContent).toContain('이 서버는 메일을 보내지 않아서');
    // the link is not left in the page behind the dialog
    expect(container.textContent).not.toContain('SECRET-TOKEN-VALUE');
  });
  it('copy puts the link on the clipboard and says so; a browser that refuses is told to select it by hand', async () => {
    await draw();
    await press(buttons()[0]);
    await press(document.querySelector('[data-testid="reset-link-copy"]'));
    expect(copied).toBe(URL_); expect(document.querySelector('[data-testid="reset-link-copy"]')?.textContent).toContain(koMessages.settings.orgMemberResetLinkCopied);
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no'));
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
    await press(document.querySelector('[data-testid="reset-link-copy"]'));
    expect(document.querySelector('[data-testid="reset-link-dialog"]')?.textContent).toContain(koMessages.common.copyFailedSelectManually);
  });
  it('closing the dialog drops the link', async () => {
    await draw();
    await press(buttons()[1]);
    expect(posts).toEqual(['admin']);
    await press([...document.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.close));
    expect(dialog()).toBeNull(); expect(document.body.textContent).not.toContain('SECRET-TOKEN-VALUE');
  });
  it('the link is dropped when the workspace or the role changes (it must not stay on screen in another organization)', async () => {
    await draw();
    await press(buttons()[0]);
    expect(dialog()).toBeTruthy();
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrgMembersSection orgId="org-2" currentRole="owner" /></NextIntlClientProvider>); });
    await flush();
    expect(dialog()).toBeNull(); expect(document.body.textContent).not.toContain('SECRET-TOKEN-VALUE');
  });
  it('English words', async () => {
    await draw('en');
    await press(buttons()[0]);
    expect(dialog()?.textContent).toContain('Password reset link'); expect(dialog()?.textContent).toContain('Whoever opens it chooses the new password'); expect(dialog()?.textContent).toContain('30 minutes');
  });
});

describe('when the server refuses', () => {
  it.each([
    ['the person is also in another organization', { status: 409, body: { error: { code: 'ORG_RESET_PERSON_IN_OTHER_ORGS' } } }, koMessages.settings.orgMemberResetLinkOtherOrgs],
    ['too many links', { status: 429, body: { error: { code: 'RATE_LIMITED' } } }, koMessages.settings.orgMemberResetLinkRateLimited],
    ['anything else', { status: 500, body: { error: { code: 'X' } } }, koMessages.settings.orgMemberResetLinkFailed],
    ['an answer that is not a link', { status: 200, body: { nothing: true } }, koMessages.settings.orgMemberResetLinkFailed],
  ])('%s → the plain sentence, no dialog', async (_n, answer, text) => {
    resetAnswer = answer as typeof resetAnswer; await draw();
    await press(buttons()[0]);
    expect(banner()).toBe(text); expect(dialog()).toBeNull();
  });
});
