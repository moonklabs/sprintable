// @vitest-environment jsdom
//
// story 4721 — the card a MEMBER (not owner/admin) meets on the Mac app's setup page. It used to be a dead end (the title and one
// «다시 확인» for a state that does not change on its own). Yuna `invited-member-card-1017` §3: the body names the organization and says
// what a member can do; the primary is «내 조직 만들어 시작하기» → the existing «조직 만들기» dialog (name filled the way the app path
// names it) → the same page again as the owner of the new organization. No primary when the plan allows no organization of their own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { TAB_PROJECT_STORAGE_KEY } from '@/lib/project-context-client';

const { ctx, ee } = vi.hoisted(() => ({ ctx: vi.fn(), ee: { on: true } }));
vi.mock('@/lib/ee', () => ({ isEEEnabled: () => ee.on }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx() }));

import { Failure } from './desktop-setup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; body?: unknown }[];
let makeOrg: () => Response;
let switchOrg: () => Response;
let meNow: () => Response;

const MEMBER_OF_ACME = [{ orgId: 'o-acme', orgName: 'Acme', orgSlug: 'acme', role: 'member' }];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  ee.on = true;
  calls = [];
  makeOrg = () => new Response(JSON.stringify({ data: { id: 'o-mine', name: '김지우의 조직', slug: 'workspace-1a2b3c4d' } }), { status: 200 });
  switchOrg = () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  meNow = () => new Response(JSON.stringify({ data: { email: 'invited@x.test', email_verified: false, email_verification_required: true } }), { status: 200 });
  window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'p-old');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/organizations') return makeOrg();
    if (url === '/api/switch-org') return switchOrg();
    if (url === '/api/auth/me') return meNow();
    return new Response('{}', { status: 404 });
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.body.innerHTML = '';
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

async function mount(memberships: unknown[], opts: { locale?: 'ko' | 'en'; orgId?: string; onReloadPage?: () => void } = {}) {
  const locale = opts.locale ?? 'ko';
  ctx.mockReturnValue({ projectId: null, userName: '김지우', orgId: opts.orgId ?? 'o-acme', orgMemberships: memberships });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <Failure failure="not-admin" onReloadPage={opts.onReloadPage} />
      </NextIntlClientProvider>,
    );
  });
}
const text = () => container.textContent ?? '';
const buttonOf = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
function setNativeValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function submitDialog() {
  const form = document.body.querySelector('form') as HTMLFormElement;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
}

describe('story 4721 — the member card', () => {
  it('names the organization, says what a member can do, and offers both exits (ko)', async () => {
    await mount(MEMBER_OF_ACME);
    expect(text()).toContain('에이전트를 만들려면 조직 관리자여야 해요'); // the title is unchanged
    expect(text()).toContain('지금 계정은 Acme의 멤버예요. 이 조직에서는 관리자가 에이전트를 시작해요. 관리자에게 부탁하거나, 내 조직을 따로 만들어 시작할 수 있어요.');
    expect(buttonOf('내 조직 만들어 시작하기')).toBeDefined();
    expect(buttonOf('다시 확인')).toBeDefined(); // stays: the right action for someone just promoted
  });

  it('en: the same card in English', async () => {
    await mount(MEMBER_OF_ACME, { locale: 'en' });
    expect(text()).toContain("You're a member of Acme. In this organization an admin starts agents. Ask an admin, or create your own organization and start there.");
    expect(buttonOf('Create my own organization')).toBeDefined();
    expect(buttonOf('Check again')).toBeDefined();
  });

  it('the organization is not in the list: «이 조직의» — a name is never made up', async () => {
    await mount([], { orgId: 'o-unknown' });
    expect(text()).toContain('지금 계정은 이 조직의 멤버예요.');
    expect(text()).not.toContain('undefined');
    expect(buttonOf('내 조직 만들어 시작하기')).toBeDefined(); // an unreadable list does not close the way (the dialog says «한도» if the plan does)
  });

  it('the plan allows no organization of their own (they own one already): no primary, «관리자에게 부탁해 주세요.», «다시 확인» stays', async () => {
    await mount([...MEMBER_OF_ACME, { orgId: 'o-owned', orgName: 'Mine', orgSlug: 'mine', role: 'owner' }]);
    expect(text()).toContain('지금 계정은 Acme의 멤버예요. 이 조직에서는 관리자가 에이전트를 시작해요. 관리자에게 부탁해 주세요.');
    expect(text()).not.toContain('내 조직을 따로 만들어');
    expect(buttonOf('내 조직 만들어 시작하기')).toBeUndefined();
    expect(buttonOf('다시 확인')).toBeDefined();
  });

  it('a build without the plan limit (OSS): owning an organization already does not close the primary', async () => {
    ee.on = false;
    await mount([...MEMBER_OF_ACME, { orgId: 'o-owned', orgName: 'Mine', orgSlug: 'mine', role: 'owner' }]);
    expect(buttonOf('내 조직 만들어 시작하기')).toBeDefined();
    expect(text()).toContain('내 조직을 따로 만들어 시작할 수 있어요');
  });

  it('[내 조직 만들어 시작하기] opens the existing «조직 만들기» dialog with the name filled the app way', async () => {
    await mount(MEMBER_OF_ACME);
    expect(document.body.querySelector('#org-name')).toBeNull();
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    expect((document.body.querySelector('#org-name') as HTMLInputElement).value).toBe('김지우의 조직');
    // a Korean-only name makes no address: the box may stay empty (the server derives it — story 4669), the dialog can still be sent
    expect((document.body.querySelector('#org-slug') as HTMLInputElement).value).toBe('');
    expect((document.body.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('create → switch to it → the same page again (as the owner of the new organization); the tab\'s old project is dropped', async () => {
    const reload = vi.fn();
    await mount(MEMBER_OF_ACME, { onReloadPage: reload });
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    await submitDialog();
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ['/api/organizations', { name: '김지우의 조직' }], // no slug key: the server derives it
      ['/api/switch-org', { org_id: 'o-mine' }],
    ]);
    expect(window.sessionStorage.getItem(TAB_PROJECT_STORAGE_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a typed address is still sent with the name', async () => {
    await mount(MEMBER_OF_ACME, { onReloadPage: vi.fn() });
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    await act(async () => { setNativeValue(document.body.querySelector('#org-slug') as HTMLInputElement, 'my-org'); });
    await submitDialog();
    expect(calls[0]).toEqual({ url: '/api/organizations', body: { name: '김지우의 조직', slug: 'my-org' } });
  });

  it('the plan says no (402): the dialog\'s limit line, nothing switched, no reload', async () => {
    const reload = vi.fn();
    makeOrg = () => new Response(JSON.stringify({ error: { code: 'PLAN_LIMIT_EXCEEDED', resource: 'org', limit: 1, upgrade_required: true } }), { status: 402 });
    await mount(MEMBER_OF_ACME, { onReloadPage: reload });
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    await submitDialog();
    expect(document.body.querySelector('[role=alert]')).not.toBeNull();
    expect(calls.map((c) => c.url)).toEqual(['/api/organizations']);
    expect(reload).not.toHaveBeenCalled();
  });

  it('the organization was made but the switch failed: the line says so, and the primary tries the SWITCH again — never a second organization', async () => {
    const reload = vi.fn();
    switchOrg = () => new Response(JSON.stringify({ error: { code: 'SWITCH_FAILED' } }), { status: 500 });
    await mount(MEMBER_OF_ACME, { onReloadPage: reload });
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    await submitDialog();
    expect(text()).toContain('조직을 전환하지 못했어요');
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(TAB_PROJECT_STORAGE_KEY)).toBe('p-old');
    switchOrg = () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['/api/organizations', '/api/switch-org', '/api/switch-org']);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain('조직을 전환하지 못했어요');
  });

  it('the move\'s own refusal card and the other failures are not touched', async () => {
    ctx.mockReturnValue({ projectId: null, userName: '김지우', orgId: 'o-acme', orgMemberships: MEMBER_OF_ACME });
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Failure failure="move-not-admin" /></NextIntlClientProvider>);
    });
    expect(text()).toContain('에이전트를 옮기려면 조직 관리자여야 해요');
    expect(buttonOf('내 조직 만들어 시작하기')).toBeUndefined();
  });

  const EMAIL_REQUIRED = () => new Response(JSON.stringify({ error: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'x' } }), { status: 403 });
  const gate = () => container.querySelector('[data-testid=email-verify-gate]');

  it('the server wants the e-mail verified (403): the e-mail gate stands in the card\'s place — no generic error, nothing switched', async () => {
    makeOrg = EMAIL_REQUIRED;
    await mount(MEMBER_OF_ACME, { onReloadPage: vi.fn() });
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    await submitDialog();
    expect(gate()).not.toBeNull();
    expect(text()).toContain('invited@x.test');
    expect(text()).not.toContain('에이전트를 만들려면 조직 관리자여야 해요'); // the gate is the page now
    expect(document.body.querySelector('#org-name')).toBeNull(); // the dialog closed
    expect(calls.map((c) => c.url)).toEqual(['/api/organizations', '/api/auth/me']);
  });

  it('after the mailbox is proved the card is back, and the primary makes the organization this time', async () => {
    makeOrg = EMAIL_REQUIRED;
    const reload = vi.fn();
    await mount(MEMBER_OF_ACME, { onReloadPage: reload });
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    await submitDialog();
    expect(gate()).not.toBeNull();
    makeOrg = () => new Response(JSON.stringify({ data: { id: 'o-mine' } }), { status: 200 });
    meNow = () => new Response(JSON.stringify({ data: { email: 'invited@x.test', email_verified: true, email_verification_required: true } }), { status: 200 });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(gate()).toBeNull();
    expect(text()).toContain('에이전트를 만들려면 조직 관리자여야 해요');
    expect(text()).not.toContain('조직을 만들지 못했어요'); // verified in the meantime: the card is just back, no error line
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    await submitDialog();
    expect(calls.map((c) => c.url).filter((u) => u === '/api/organizations' || u === '/api/switch-org')).toEqual(['/api/organizations', '/api/organizations', '/api/switch-org']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the server says «verify first» but /me says the mailbox is proved: no gate to show — the card with the generic line', async () => {
    makeOrg = EMAIL_REQUIRED;
    meNow = () => new Response(JSON.stringify({ data: { email: 'invited@x.test', email_verified: true, email_verification_required: true } }), { status: 200 });
    await mount(MEMBER_OF_ACME, { onReloadPage: vi.fn() });
    await act(async () => { buttonOf('내 조직 만들어 시작하기')!.click(); });
    await submitDialog();
    expect(gate()).toBeNull();
    expect(text()).toContain('조직을 만들지 못했어요');
    expect(buttonOf('내 조직 만들어 시작하기')).toBeDefined();
  });
});
