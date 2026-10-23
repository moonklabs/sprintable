// @vitest-environment jsdom
//
// story 4725 decision 2 — the one-time notice of what was cut when a person's unproved account was reclaimed (Yuna's copy). Drawn only while the server has the mark;
// names only what the server says it cut; the password line only when the password was cleared; [닫기] clears the server's mark and the notice does not come back.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { ReclaimNoticeAlert, reclaimNoticeOf } from './reclaim-notice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let calls: { url: string; method?: string }[];
let meBody: unknown;
let dismissStatus: number;

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  calls = [];
  meBody = { data: { reclaim_notice: { cut: ['sessions', 'providers', 'two_step', 'keys', 'phones', 'computers'], password_cleared: true } } };
  dismissStatus = 200;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.method ? { method: init.method } : {}) });
    if (url === '/api/auth/me') return new Response(JSON.stringify(meBody), { status: 200 });
    if (url === '/api/auth/reclaim-notice/dismiss') return new Response(JSON.stringify({ data: { dismissed: true } }), { status: dismissStatus });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><ReclaimNoticeAlert /></NextIntlClientProvider>);
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
const text = () => container.textContent ?? '';
const notice = () => container.querySelector('[data-testid=reclaim-notice]');
const closeButton = () => container.querySelector('[data-testid=reclaim-notice-close]') as HTMLButtonElement | null;

describe('story 4725 — the reclaim notice', () => {
  it('ko: the server says everything was cut → title · the list · what stays · the password line · [닫기] (outline, on the right)', async () => {
    await mount();
    expect(text()).toContain('이 주소를 인증하기 전에 있던 연결을 끊었어요');
    expect(text()).toContain('그때 이 계정에 있던 로그인 상태 · 다른 로그인 방식 · 2단계 인증 · 키 · 등록한 폰과 컴퓨터를 끊었어요. 조직과 멤버십은 그대로예요 — 필요한 건 새로 만들면 돼요.');
    expect(text()).toContain('비밀번호도 비웠어요. 쓰려면 로그인 화면의 «비밀번호를 잊으셨나요?»로 새로 정해 주세요.');
    expect(closeButton()!.textContent).toBe('닫기');
    expect(closeButton()!.className).not.toMatch(/bg-primary/); // not a filled button
  });

  it('the notice carries the info icon (decorative) so its text starts in the text column like the sibling notices', async () => {
    await mount();
    const icon = notice()!.querySelector(':scope > svg');
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute('aria-hidden')).toBe('true');
  });

  it('it is a neutral status, not an alert: role=status, no alert role, never closes by itself', async () => {
    await mount();
    expect(notice()!.getAttribute('role')).toBe('status');
    expect(container.querySelector('[role=alert]')).toBeNull();
  });

  it('names ONLY what the server says it cut — and the particle follows the last word', async () => {
    meBody = { data: { reclaim_notice: { cut: ['sessions', 'keys'], password_cleared: false } } };
    await mount();
    expect(text()).toContain('그때 이 계정에 있던 로그인 상태 · 키를 끊었어요.');
    expect(text()).not.toContain('2단계 인증');
    expect(text()).not.toContain('컴퓨터');
    meBody = { data: { reclaim_notice: { cut: ['providers', 'two_step'], password_cleared: false } } };
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount();
    expect(text()).toContain('다른 로그인 방식 · 2단계 인증을 끊었어요.');                  // 인증 + 을
  });

  it('the second line (password) only when the server cleared the password', async () => {
    meBody = { data: { reclaim_notice: { cut: ['sessions'], password_cleared: false } } };
    await mount();
    expect(text()).not.toContain('비밀번호도 비웠어요');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    meBody = { data: { reclaim_notice: { cut: [], password_cleared: true } } };
    await mount();
    expect(text()).toContain('비밀번호도 비웠어요');
    expect(text()).not.toContain('그때 이 계정에 있던');                                       // nothing else to list
  });

  it('en: the list reads as a sentence (Intl list) and the password line quotes the sign-in screen\'s own words', async () => {
    meBody = { data: { reclaim_notice: { cut: ['sessions', 'providers', 'keys'], password_cleared: true } } };
    await mount('en');
    expect(text()).toContain('We disconnected what existed before you verified this address');
    expect(text()).toContain('What this account had at that time — sign-ins, other sign-in methods, and keys — was disconnected. Your organizations and memberships are unchanged; create what you need again.');
    expect(text()).toContain('The password was cleared too. To use one, choose a new one with “Forgot your password?” on the sign-in screen.');
    expect(closeButton()!.textContent).toBe('Close');
  });

  it('no mark (or a body that is not the server\'s shape, or /me not readable): nothing is drawn', async () => {
    for (const body of [{ data: { reclaim_notice: null } }, { data: {} }, { data: { reclaim_notice: { cut: 'sessions', password_cleared: true } } }, { data: { reclaim_notice: { cut: ['nothing-known'], password_cleared: false } } }, null]) {
      meBody = body;
      await act(async () => { root.unmount(); }); root = createRoot(container);
      await mount();
      expect(notice(), JSON.stringify(body)).toBeNull();
    }
  });

  it('[닫기] asks the server to clear its mark (POST) and the notice goes; it does not come back on the next mount once the server forgot it', async () => {
    await mount();
    await act(async () => { closeButton()!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(calls.filter((c) => c.url === '/api/auth/reclaim-notice/dismiss').map((c) => c.method)).toEqual(['POST']);
    expect(notice()).toBeNull();
    meBody = { data: { reclaim_notice: null } };                                              // what the server answers after the dismissal
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await mount();
    expect(notice()).toBeNull();
  });

  it('the server could not clear it: the notice stays (the mark is still there) and the button works again', async () => {
    dismissStatus = 500;
    await mount();
    await act(async () => { closeButton()!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(notice()).not.toBeNull();
    expect(closeButton()!.disabled).toBe(false);
  });

  it('it is mounted in the signed-in shell (a built notice nobody mounts tells no one)', () => {
    const shell = readFileSync(path.resolve(__dirname, '..', '..', 'app', 'dashboard', 'dashboard-shell.tsx'), 'utf8');
    expect(shell).toContain("import { ReclaimNoticeAlert } from '@/components/auth/reclaim-notice';");
    expect(shell).toMatch(/<ReclaimNoticeAlert \/>/);
  });

  it('reclaimNoticeOf reads the envelope or a bare body and keeps only names it knows', () => {
    expect(reclaimNoticeOf({ data: { reclaim_notice: { cut: ['keys', 'x', 'sessions'], password_cleared: true } } })).toEqual({ cut: ['sessions', 'keys'], passwordCleared: true });
    expect(reclaimNoticeOf({ reclaim_notice: { cut: ['phones'], password_cleared: false } })).toEqual({ cut: ['phones'], passwordCleared: false });
    expect(reclaimNoticeOf({ data: { reclaim_notice: { cut: [], password_cleared: false } } })).toBeNull();
    expect(reclaimNoticeOf(undefined)).toBeNull();
  });
});
