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
      <OnboardingForm />
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

async function fillOrgForm() {
  const nameInput = container.querySelector('input') as HTMLInputElement;
  const setNative = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setNative.call(nameInput, 'Test Org');
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submitButton(): HTMLButtonElement {
  const btns = Array.from(container.querySelectorAll('button'));
  return btns.find((b) => /조직 만들기|Create Organization/.test(b.textContent ?? '')) as HTMLButtonElement;
}

describe('OnboardingForm — EMAIL_VERIFICATION_REQUIRED (story #2441)', () => {
  it('ko: code로 분기해 한국어 안내 + 재전송 버튼을 실제로 렌더한다(raw 영문 노출 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
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
    await fillOrgForm();
    await act(async () => { submitButton().click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // raw 영문 에러 문자열이 화면에 그대로 노출되면 안 된다(#2437에서 실제로 겪은 결함).
    expect(container.textContent).not.toContain('Email verification required to create organization');
    expect(container.textContent).toContain('이메일 인증');
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '인증 메일 재전송');
    expect(resendBtn).toBeTruthy();
  });

  it('en: 같은 code에 대해 영문 안내+resend 버튼을 렌더한다(en/ko 정합)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
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
    await fillOrgForm();
    await act(async () => { submitButton().click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Resend verification email');
    expect(resendBtn).toBeTruthy();
  });

  it('재전송 버튼 클릭 → 실제로 /api/auth/resend-verification을 호출하고 성공 문구를 렌더한다', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
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
    await fillOrgForm();
    await act(async () => { submitButton().click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '인증 메일 재전송') as HTMLButtonElement;
    await act(async () => { resendBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(calls).toContain('/api/auth/resend-verification');
    expect(container.textContent).toContain('인증 메일을 다시 보냈습니다');
  });

  it('재전송 429(rate-limit) → 재전송 실패가 아니라 rate-limit 전용 문구를 보여준다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
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
    await fillOrgForm();
    await act(async () => { submitButton().click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '인증 메일 재전송') as HTMLButtonElement;
    await act(async () => { resendBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('너무 자주 요청했습니다');
  });

  it('다른 403(code 없음/다른 code)은 기존 일반 에러 배너로 가고, 재전송 UI는 뜨지 않는다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
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
    await fillOrgForm();
    await act(async () => { submitButton().click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('Slug already exists');
    const resendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '인증 메일 재전송');
    expect(resendBtn).toBeUndefined();
  });
});
