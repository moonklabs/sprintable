// @vitest-environment jsdom
//
// story 4711 AC4 덧 (PO 2026-10-17 · Yuna's sheet) — the invited card: a [들어가기] on every invite line that takes THAT invite from inside the app, a failure line of its own
// per reason, and the small link «내 조직을 새로 만들기». The accept goes to `/api/invites/mine/{invite_id}/accept` (the list carries no token), then `/api/switch-org`,
// then the page is read again.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { TAB_PROJECT_STORAGE_KEY } from '@/lib/project-context-client';
import { InvitedCard, type MyInvite } from './desktop-setup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A: MyInvite = { invite_id: '11111111-1111-4111-8111-111111111111', org_id: 'org-a', org_name: '뭉클랩', role: 'admin', expires_at: '2099-10-06T12:00:00Z' };
const B: MyInvite = { invite_id: '22222222-2222-4222-8222-222222222222', org_id: 'org-b', org_name: '다른 팀', role: 'member', expires_at: '2099-10-07T12:00:00Z' };

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; method?: string; body?: string }[];
let acceptAnswer: (id: string) => Response | Promise<Response>;
let switchOk: boolean;
let onReload: Mock<() => void>;
let onCreateOwn: Mock<() => void>;

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  calls = [];
  onReload = vi.fn<() => void>(); onCreateOwn = vi.fn<() => void>();
  switchOk = true;
  acceptAnswer = (id) => new Response(JSON.stringify({ ok: true, org_id: id === A.invite_id ? 'org-a' : 'org-b', role: 'member' }), { status: 200 });
  window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'old-project');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.method ? { method: init.method } : {}), ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    const m = url.match(/\/api\/invites\/mine\/([^/]+)\/accept$/);
    if (m) return acceptAnswer(decodeURIComponent(m[1]!));
    if (url === '/api/switch-org') return new Response(JSON.stringify({ data: { ok: switchOk } }), { status: switchOk ? 200 : 500 });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

async function mount(invites: MyInvite[], locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <InvitedCard invites={invites} onReload={onReload} onCreateOwn={onCreateOwn} />
      </NextIntlClientProvider>,
    );
  });
}
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const joins = () => [...container.querySelectorAll('[data-testid=setup-invited-join]')] as HTMLButtonElement[];
const press = async (b: HTMLButtonElement) => { await act(async () => { b.click(); }); await flush(); };
const ownOrg = () => container.querySelector('[data-testid=setup-invited-own-org]') as HTMLButtonElement;
const fail = (why: string) => container.querySelector(`[data-testid=setup-invited-fail-${why}]`);
const acceptCalls = () => calls.filter((c) => /\/accept$/.test(c.url));

describe('story 4711 AC4 — the invited card', () => {
  it('the mail-link line is gone; each invite line has its own [들어가기] (aria names the org) and the link «내 조직을 새로 만들기» is at the bottom', async () => {
    await mount([A, B]);
    expect(container.textContent).not.toContain('메일');
    expect(joins().map((b) => b.getAttribute('aria-label'))).toEqual(['들어가기 · 뭉클랩', '들어가기 · 다른 팀']);
    expect(joins().map((b) => b.textContent)).toEqual(['들어가기', '들어가기']);
    expect(ownOrg().textContent).toBe('내 조직을 새로 만들기');
    expect(container.querySelector('[data-testid=setup-invited]')!.lastElementChild!.contains(ownOrg())).toBe(true);
  });

  it('one invite → a filled button; several → an outline button per line (never several filled ones on one screen)', async () => {
    await mount([A]);
    expect(joins()[0]!.className).toMatch(/bg-primary/);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount([A, B]);
    expect(joins().every((b) => !/bg-primary/.test(b.className) && /border/.test(b.className))).toBe(true);
  });

  it('pressing a line accepts THAT invite only (by its id), then switches into its organization, drops the tab project and reads the page again', async () => {
    await mount([A, B]);
    await press(joins()[1]!);
    expect(acceptCalls().map((c) => c.url)).toEqual([`/api/invites/mine/${B.invite_id}/accept`]);
    expect(acceptCalls()[0]!.method).toBe('POST');
    const sw = calls.find((c) => c.url === '/api/switch-org')!;
    expect(JSON.parse(sw.body!)).toEqual({ org_id: 'org-b' });
    expect(calls.map((c) => c.url)).toEqual([`/api/invites/mine/${B.invite_id}/accept`, '/api/switch-org']);      // accept first, then the switch
    expect(window.sessionStorage.getItem(TAB_PROJECT_STORAGE_KEY)).toBeNull();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('while a press is in flight every line\'s button is off, the pressed one says «들어가는 중이에요…», the link is off too, and a second press makes no second accept', async () => {
    let release: (r: Response) => void = () => {};
    acceptAnswer = () => new Promise<Response>((res) => { release = res; });
    await mount([A, B]);
    await act(async () => { joins()[0]!.click(); });
    expect(joins().map((b) => b.disabled)).toEqual([true, true]);
    expect(joins()[0]!.textContent).toBe('들어가는 중이에요…');
    expect(joins()[0]!.getAttribute('aria-busy')).toBe('true');
    expect(joins()[1]!.getAttribute('aria-busy')).toBe('false');
    expect(joins()[1]!.textContent).toBe('들어가기');
    expect(ownOrg().disabled).toBe(true);
    await act(async () => { joins()[1]!.click(); joins()[0]!.click(); });
    expect(acceptCalls()).toHaveLength(1);
    await act(async () => { release(new Response(JSON.stringify({ ok: true, org_id: 'org-a' }), { status: 200 })); });
    await flush();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('two presses in the same tick make ONE accept (the second sees the first in flight, before any re-render)', async () => {
    let release: (r: Response) => void = () => {};
    acceptAnswer = () => new Promise<Response>((res) => { release = res; });
    await mount([A]);
    await act(async () => { const b = joins()[0]!; b.click(); b.click(); });
    expect(acceptCalls()).toHaveLength(1);
    await act(async () => { release(new Response(JSON.stringify({ ok: true, org_id: 'org-a' }), { status: 200 })); });
    await flush();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('already accepted (409): its own neutral status line + [다시 불러오기] (the has-org button text); the button stays', async () => {
    acceptAnswer = () => new Response('{}', { status: 409 });
    await mount([A]);
    await press(joins()[0]!);
    const line = fail('already')!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toContain('이 초대는 이미 수락됐어요 — 다시 불러오면 그 조직이 보여요.');
    const reload = [...line.querySelectorAll('button')].find((b) => b.textContent === koMessages.desktop.setup.failure['has-org'].action)!;
    await act(async () => { reload.click(); });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(joins()[0]!.disabled).toBe(false);
  });

  it('expired (410): neutral status line, no reload button, and THAT line\'s [들어가기] is gone (the other line keeps its own)', async () => {
    acceptAnswer = (id) => (id === A.invite_id ? new Response('{}', { status: 410 }) : new Response('{}', { status: 500 }));
    await mount([A, B]);
    await press(joins()[0]!);
    const line = fail('expired')!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toContain('이 초대는 기한이 지났어요 — 초대한 사람에게 다시 보내 달라고 해 주세요.');
    expect(line.querySelectorAll('button')).toHaveLength(0);
    expect(joins()).toHaveLength(1);
    expect(joins()[0]!.getAttribute('aria-label')).toBe('들어가기 · 다른 팀');
  });

  it('not this account\'s (403 or 404): an alert line + [다시 불러오기]', async () => {
    for (const status of [403, 404]) {
      acceptAnswer = () => new Response('{}', { status });
      await act(async () => { root.unmount(); }); root = createRoot(container);
      await mount([A]);
      await press(joins()[0]!);
      const line = fail('notMine')!;
      expect(line.getAttribute('role'), String(status)).toBe('alert');
      expect(line.textContent).toContain('이 계정으로 받은 초대가 아니에요 — 목록을 다시 불러와 주세요.');
      expect(line.querySelectorAll('button')).toHaveLength(1);
    }
  });

  it('unknown (a server error · a network failure · an answer without an organization · a switch that did not go through): an alert line, no reload button, the button works again, the page is NOT read again', async () => {
    const cases: [string, () => void][] = [
      ['500', () => { acceptAnswer = () => new Response('{}', { status: 500 }); }],
      ['no org in the answer', () => { acceptAnswer = () => new Response(JSON.stringify({ ok: true }), { status: 200 }); }],
      ['network', () => { acceptAnswer = () => { throw new Error('offline'); }; }],
      ['switch failed', () => { switchOk = false; }],
    ];
    for (const [name, arrange] of cases) {
      switchOk = true;
      acceptAnswer = (id) => new Response(JSON.stringify({ ok: true, org_id: id === A.invite_id ? 'org-a' : 'org-b' }), { status: 200 });
      arrange();
      await act(async () => { root.unmount(); }); root = createRoot(container);
      await mount([A]);
      await press(joins()[0]!);
      const line = fail('unknown')!;
      expect(line, name).not.toBeNull();
      expect(line.getAttribute('role'), name).toBe('alert');
      expect(line.textContent, name).toContain('들어가지 못했어요 — 다시 눌러 주세요');
      expect(line.querySelectorAll('button'), name).toHaveLength(0);
      expect(joins()[0]!.disabled, name).toBe(false);
    }
    expect(onReload).not.toHaveBeenCalled();
  });

  it('accepted but the switch did not go through: the retry switches again WITHOUT accepting again (the invite is not pending any more)', async () => {
    switchOk = false;
    await mount([A]);
    await press(joins()[0]!);
    expect(fail('unknown')).not.toBeNull();
    expect(acceptCalls()).toHaveLength(1);
    switchOk = true;
    await press(joins()[0]!);
    expect(acceptCalls()).toHaveLength(1);                                       // still the one accept
    expect(calls.filter((c) => c.url === '/api/switch-org')).toHaveLength(2);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('a new press clears that line\'s old failure', async () => {
    acceptAnswer = () => new Response('{}', { status: 500 });
    await mount([A]);
    await press(joins()[0]!);
    expect(fail('unknown')).not.toBeNull();
    acceptAnswer = () => new Response(JSON.stringify({ ok: true, org_id: 'org-a' }), { status: 200 });
    await press(joins()[0]!);
    expect(fail('unknown')).toBeNull();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('«내 조직을 새로 만들기» hands over to the caller (and makes no accept)', async () => {
    await mount([A]);
    await act(async () => { ownOrg().click(); });
    expect(onCreateOwn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('en: the button, the aria label, the progress, the link and the failure lines are Yuna\'s English', async () => {
    acceptAnswer = () => new Response('{}', { status: 410 });
    await mount([A], 'en');
    expect(joins()[0]!.textContent).toBe('Join');
    expect(joins()[0]!.getAttribute('aria-label')).toBe('Join · 뭉클랩');
    expect(ownOrg().textContent).toBe('Create my own organization');
    await press(joins()[0]!);
    expect(fail('expired')!.textContent).toContain('This invitation has expired — ask the person who invited you to send it again.');
  });
});
