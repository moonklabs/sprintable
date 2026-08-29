// @vitest-environment jsdom
//
// story #3195(온보딩·FE) — 이메일 인증 왕복(가입 → 1/4 입력 → EMAIL_VERIFICATION_REQUIRED
// 400 → 메일함 링크 → verify-email → 「시작하기」 복귀)이 풀 페이지 네비게이션이라
// OnboardingForm이 통째로 리마운트돼 orgName/orgSlug가 사라졌다(재입력 강요). AC1: 왕복
// 후 복귀 시 1/4 입력값이 sessionStorage draft로 보존돼 있다. AC2: 미인증 상태 안내가
// 제출 전에(마운트 시 /api/me.email_verified===false로) 보인다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DRAFT_KEY = 'sp_onboarding_org_draft';

let container: HTMLDivElement;
let root: Root;

function wrap() {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <OnboardingForm />
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function mockFetchDefault(overrides: Record<string, () => Promise<unknown>> = {}) {
  return vi.fn(async (url: string) => {
    if (url in overrides) return overrides[url]!();
    if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) } as Response;
    if (url === '/api/me') return { ok: true, json: async () => ({ data: {} }) } as Response;
    throw new Error('unexpected fetch: ' + url);
  });
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('OnboardingForm — 1/4 입력값 sessionStorage draft 영속(story #3195 AC1)', () => {
  it('조직명 입력 시 draft가 sessionStorage에 저장된다', async () => {
    vi.stubGlobal('fetch', mockFetchDefault());
    await act(async () => { root.render(wrap()); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => { setNativeValue(nameInput, '새싹상회'); });

    const raw = sessionStorage.getItem(DRAFT_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { orgName: string; orgSlug: string };
    expect(parsed.orgName).toBe('새싹상회');
  });

  it('재마운트(=인증 왕복 시뮬레이션) 시 draft가 복원돼 재입력을 요구하지 않는다', async () => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ orgName: '새싹상회', orgSlug: 'saessak-shop' }));
    vi.stubGlobal('fetch', mockFetchDefault());
    await act(async () => { root.render(wrap()); });
    await flush();

    const nameInput = container.querySelector('input') as HTMLInputElement;
    expect(nameInput.value).toBe('새싹상회');
    const inputs = container.querySelectorAll('input');
    expect((inputs[1] as HTMLInputElement).value).toBe('saessak-shop');
  });

  it('조직 생성 성공 시 draft를 지운다(더는 필요 없어짐)', async () => {
    vi.stubGlobal('fetch', mockFetchDefault({
      '/api/organizations': async () => ({ ok: true, json: async () => ({ data: { id: 'org-1' } }) }),
      '/api/auth/refresh': async () => ({ ok: true, json: async () => ({}) }),
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    const inputs = container.querySelectorAll('input');
    await act(async () => { setNativeValue(inputs[0] as HTMLInputElement, 'New Org'); });
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeTruthy();

    const submitBtn = [...container.querySelectorAll('button')].find((b) => /조직 만들기/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('EMAIL_VERIFICATION_REQUIRED로 실패해도 draft는 그대로 남는다(왕복 중 소실 금지)', async () => {
    vi.stubGlobal('fetch', mockFetchDefault({
      '/api/organizations': async () => ({
        ok: false, status: 403,
        json: async () => ({ error: { code: 'EMAIL_VERIFICATION_REQUIRED', message: 'x' } }),
      }),
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    const inputs = container.querySelectorAll('input');
    await act(async () => { setNativeValue(inputs[0] as HTMLInputElement, 'New Org'); });
    const submitBtn = [...container.querySelectorAll('button')].find((b) => /조직 만들기/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(sessionStorage.getItem(DRAFT_KEY)).toBeTruthy();
  });
});

describe('OnboardingForm — 미인증 선제 고지(story #3195 AC2)', () => {
  it('/api/me.email_verified===false면 제출 前(마운트 시)부터 안내+재전송 버튼이 보인다', async () => {
    vi.stubGlobal('fetch', mockFetchDefault({
      '/api/me': async () => ({ ok: true, json: async () => ({ data: { email_verified: false } }) }),
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    const resendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '인증 메일 재전송');
    expect(resendBtn).toBeTruthy();
    // 아직 제출(조직 만들기)을 누르지 않았다 — 배너가 마운트 시점부터 선제로 떴다는 증거.
    const submitBtn = [...container.querySelectorAll('button')].find((b) => /조직 만들기/.test(b.textContent ?? ''));
    expect(submitBtn).toBeTruthy();
  });

  it('/api/me.email_verified===true면 선제 고지가 안 뜬다(회귀 없음)', async () => {
    vi.stubGlobal('fetch', mockFetchDefault({
      '/api/me': async () => ({ ok: true, json: async () => ({ data: { email_verified: true } }) }),
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    const resendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '인증 메일 재전송');
    expect(resendBtn).toBeUndefined();
  });

  it('/api/me.email_verified===null(판정 불가)이면 안내가 안 뜬다 — 제출 시 400 분기가 안전망으로 남는다', async () => {
    vi.stubGlobal('fetch', mockFetchDefault({
      '/api/me': async () => ({ ok: true, json: async () => ({ data: { email_verified: null } }) }),
    }));
    await act(async () => { root.render(wrap()); });
    await flush();

    const resendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '인증 메일 재전송');
    expect(resendBtn).toBeUndefined();
  });
});
