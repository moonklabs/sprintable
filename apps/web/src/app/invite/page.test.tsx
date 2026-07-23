// @vitest-environment jsdom
//
// story #2084(i18n 1순위) — joinHeading을 t.rich()로 바꾸면서 PO가 명시한 위험: 태그 이름이
// 안 맞거나 함수가 빠지면 화면에 "<b>" 문자가 그대로 찍히거나 빈 문자열이 나오는데
// type-check로는 안 잡힌다. ko/en 양쪽에서 조직명이 <b> 태그 없이 강조 span으로 렌더되고,
// 문장이 한 줄로 정확히 나오는지 실제 DOM으로 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import InvitePage from './page';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('token=tok-1'),
  useRouter: () => ({ push: vi.fn() }),
}));

let container: HTMLDivElement;
let root: Root;

function wrap(locale: 'ko' | 'en', node: React.ReactNode) {
  const messages = locale === 'ko' ? koMessages : enMessages;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const PREVIEW = { org_name: '뭉클랩', role: 'member' as const, expires_at: '2099-01-01', email: 'a@b.com' };

function stubSuccessFlow() {
  // preview fetch → /api/me(미인증, auth 화면으로) — success 상태는 직접 auth 성공 경로로 유도.
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
    if (url.includes('/api/invites/tok-1') && !url.includes('accept')) {
      return { ok: true, json: async () => ({ data: PREVIEW }) };
    }
    if (url === '/api/me') return { ok: false } as Response;
    if (url === '/api/auth/login' && opts?.method === 'POST') {
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes('/accept')) {
      return { ok: true, json: async () => ({}) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('InvitePage — joinHeading t.rich() 렌더 (story #2084)', () => {
  it('ko: 조직명이 <b> 리터럴 없이 강조 span으로 렌더되고 문장이 정확하다', async () => {
    stubSuccessFlow();
    await act(async () => { root.render(wrap('ko', <InvitePage />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('뭉클랩에 합류하세요');
    expect(h1?.innerHTML).not.toContain('<b>');
    expect(h1?.innerHTML).not.toContain('&lt;b&gt;');
    const emphasized = h1?.querySelector('span.font-semibold');
    expect(emphasized?.textContent).toBe('뭉클랩');
  });

  it('en: 조직명이 <b> 리터럴 없이 강조 span으로 렌더되고 문장이 정확하다', async () => {
    stubSuccessFlow();
    await act(async () => { root.render(wrap('en', <InvitePage />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe('Join 뭉클랩');
    expect(h1?.innerHTML).not.toContain('<b>');
    const emphasized = h1?.querySelector('span.font-semibold');
    expect(emphasized?.textContent).toBe('뭉클랩');
  });
});

// story #2105 2차 — 초대 프리뷰 실패/가입 성공 결과가 role/aria-live로 스크린리더에 낭독되는지.
// 'preview-loading'/'accepting'에서 비동기로 전이되는 상태라(reset-password의 정적 초기렌더
// invalidLink와 달리) aria-live 대상이다.
describe('InvitePage — 결과 피드백 접근성(story #2105 2차)', () => {
  it('프리뷰 로드 실패 시 role="alert" aria-live="assertive"로 사유가 렌더된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/invites/tok-1') && !url.includes('accept')) {
        return { ok: false, json: async () => ({ error: { message: '초대가 만료되었습니다.' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap('ko', <InvitePage />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain('초대가 만료되었습니다.');
    expect(alertEl?.getAttribute('aria-live')).toBe('assertive');
  });

  it('가입 성공 시 role="status" aria-live="polite"로 결과가 렌더된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.includes('/api/invites/tok-1') && !url.includes('accept')) {
        return { ok: true, json: async () => ({ data: PREVIEW }) };
      }
      if (url === '/api/me') return { ok: false } as Response;
      if (url === '/api/auth/register' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap('ko', <InvitePage />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    const tosCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(nameInput, '홍길동');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(passwordInput, 'password123!');
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      tosCheckbox.click();
    });
    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '합류하기');
    await act(async () => {
      submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const statusEl = container.querySelector('[role="status"]');
    expect(statusEl).not.toBeNull();
    expect(statusEl?.getAttribute('aria-live')).toBe('polite');
    expect(statusEl?.textContent).toContain('뭉클랩');
  });
});
