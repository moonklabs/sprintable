// @vitest-environment jsdom
//
// story #2441 — #2437 실측: 신규 유저가 "조직 만들기"에서 영문 403("Email verification
// required...")에 막히고 재전송·다음행동 안내가 0이라 완주 불가했다. 오늘 반복된 교훈(소스매칭
// 가드는 "이름이 있는가"만 보고 "실제로 그렇게 도는가"는 안 본다 — #2419/#2822/#2434 전부 같은
// 클래스)을 따라, 실제로 폼을 마운트하고 fetch를 스텁해 DOM에 재전송 버튼·안내문이 실제로
// 뜨는지·클릭이 실제로 재전송 API를 호출하는지를 단언한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(locale: 'ko' | 'en') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
      <OnboardingForm todayHref="/today" chatsHref="/chats" />
    </NextIntlClientProvider>
  );
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

// story 4715: no name field — arrival reads who the person is and their invites (none), then sends the organization itself
function arrivalAnswer(url: string): Response | null {
  if (url === '/api/auth/me') return { ok: true, json: async () => ({ data: { member_id: 'u-1', email_verified: true, org_id: null, org_member_id: null } }) } as Response;
  if (url === '/api/invites/mine') return { ok: true, json: async () => ({ invites: [] }) } as Response; // the backend's one shape (no envelope)
  if (url === '/api/auth/refresh') return { ok: true, json: async () => ({ data: {} }) } as Response; // story 4763: the arrival renews the token once before it decides «no organization»
  return null;
}

async function arrive() {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
}

describe('OnboardingForm — EMAIL_VERIFICATION_REQUIRED (story #2441)', () => {
  it('ko: code로 분기해 한국어 안내 + 재전송 버튼을 실제로 렌더한다(raw 영문 노출 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const a = arrivalAnswer(url);
      if (a) return a;
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
      if (url === '/api/organizations') {
        return {
          ok: false,
          status: 403,
          json: async () => ({ data: null, error: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'Email verification required to create organization' }, meta: null }),
        } as Response;
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap('ko')); });
    await arrive();

    // raw 영문 에러 문자열이 화면에 그대로 노출되면 안 된다(#2437에서 실제로 겪은 결함).
    expect(container.textContent).not.toContain('Email verification required to create organization');
    expect(container.textContent).toContain('이메일 인증');
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '인증 메일 다시 보내기');
    expect(resendBtn).toBeTruthy();
  });

  it('en: 같은 code에 대해 영문 안내+resend 버튼을 렌더한다(en/ko 정합)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const a = arrivalAnswer(url);
      if (a) return a;
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
      if (url === '/api/organizations') {
        return {
          ok: false,
          status: 403,
          json: async () => ({ data: null, error: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'Email verification required to create organization' }, meta: null }),
        } as Response;
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap('en')); });
    await arrive();

    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Resend verification email');
    expect(resendBtn).toBeTruthy();
  });

  it('재전송 버튼 클릭 → 실제로 /api/auth/resend-verification을 호출하고 성공 문구를 렌더한다', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      const a = arrivalAnswer(url);
      if (a) return a;
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
      if (url === '/api/organizations') {
        return {
          ok: false,
          status: 403,
          json: async () => ({ data: null, error: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'x' }, meta: null }),
        } as Response;
      }
      if (url === '/api/auth/resend-verification') {
        return { ok: true, status: 200, json: async () => ({ data: { message: 'Verification email sent', delivered: true } }) } as Response;
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap('ko')); });
    await arrive();

    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '인증 메일 다시 보내기') as HTMLButtonElement;
    await act(async () => { resendBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(calls).toContain('/api/auth/resend-verification');
    // story #3901 — 리터럴 재-pin 대신 ko.json 값을 읽어 대조.
    expect(container.textContent).toContain(koMessages.onboarding.resendSent);
  });

  it('재전송 429(rate-limit) → 재전송 실패가 아니라 rate-limit 전용 문구를 보여준다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const a = arrivalAnswer(url);
      if (a) return a;
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
      if (url === '/api/organizations') {
        return {
          ok: false,
          status: 403,
          json: async () => ({ data: null, error: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'x' }, meta: null }),
        } as Response;
      }
      if (url === '/api/auth/resend-verification') {
        return { ok: false, status: 429, json: async () => ({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }) } as Response;
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap('ko')); });
    await arrive();

    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '인증 메일 다시 보내기') as HTMLButtonElement;
    await act(async () => { resendBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // story #3901 — 리터럴 재-pin 대신 ko.json 값을 읽어 대조.
    expect(container.textContent).toContain(koMessages.onboarding.resendRateLimited);
  });

  it('다른 403(code 없음/다른 code)은 기존 일반 에러 배너로 가고, 재전송 UI는 뜨지 않는다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const a = arrivalAnswer(url);
      if (a) return a;
      if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
      if (url === '/api/organizations') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ data: null, error: { code: 'CONFLICT', message: 'Slug already exists' }, meta: null }),
        } as Response;
      }
      throw new Error('unexpected fetch: ' + url);
    }));

    await act(async () => { root.render(wrap('ko')); });
    await arrive();

    // story #2484 — 유나 design:changes(2026-08-06): 이 폴백은 raw 서버 message를 그대로
    // 노출했었다(같은 병). 지금은 generic 번역 문구로 간다 — raw는 절대 안 보여야 한다.
    expect(container.textContent).not.toContain('Slug already exists');
    // story #3901 — 리터럴 재-pin 대신 ko.json 값을 읽어 대조.
    expect(container.textContent).toContain(koMessages.onboarding.createOrgFailed);
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '인증 메일 다시 보내기');
    expect(resendBtn).toBeUndefined();
  });
});
