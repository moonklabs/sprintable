// @vitest-environment jsdom
//
// story #2469(P1, 2026-08-06 PO 라이브 재현) — /login은 한국어인데 /register는 100% 영문
// 하드코딩("Create your account/Name/Email/Password/Sign up/...")이었다. 신규 유저 전원이
// 첫 화면에서 만나는 결함. 소스매칭(문자열이 파일에 "있는지")만으론 안 잡힌다 — next-intl
// 미배선이면 raw key가 그대로 뜨거나 런타임에서 죽을 수 있어(login/page.test.tsx와 동형
// 패턴) 실제로 마운트해 DOM 텍스트를 확認한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

// story #3220 — searchParamsRef를 vi.hoisted로 노출해 next 파라미터를 테스트별로
// 갈아끼운다(login/page.test.tsx와 동일 패턴). beforeEach에서 빈 값으로 리셋.
const { pushMock, refreshMock, searchParamsRef } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => searchParamsRef.current,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  searchParamsRef.current = new URLSearchParams();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.resetModules();
});

async function mount(locale: 'ko' | 'en' = 'ko') {
  const { default: RegisterPage } = await import('./page');
  await act(async () => { root.render(wrap(locale, <RegisterPage />)); });
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('RegisterPage (story #2469) — ko locale이 실제로 렌더된다(raw 영문 회귀가드)', () => {
  it('placeholder·CTA·ToS 문구가 전부 한국어로 실제 DOM에 뜬다', async () => {
    await mount('ko');
    expect(container.querySelector('input[placeholder="이름"]')).not.toBeNull();
    expect(container.querySelector('input[placeholder="이메일"]')).not.toBeNull();
    expect(container.querySelector('input[placeholder="비밀번호"]')).not.toBeNull();
    expect(container.textContent).toContain('계정 만들기');
    expect(container.textContent).toContain('회원가입');
    expect(container.textContent).toContain('이용약관');
    expect(container.textContent).toContain('개인정보처리방침');
    expect(container.textContent).toContain('이미 계정이 있으신가요?');
    expect(container.textContent).toContain('로그인');
  });

  it('예전 raw 영문 문구가 하나도 안 남아있다(회귀가드 — "Create your account" 등)', async () => {
    await mount('ko');
    for (const legacy of [
      'Create your account', 'Sign up', 'Already have an account', 'Sign in',
      'I agree to the', 'Terms of Service', 'Privacy Policy', 'or continue with',
    ]) {
      expect(container.textContent).not.toContain(legacy);
    }
    // placeholder 속성도 별도 확認(textContent엔 안 잡힘)
    expect(container.querySelector('input[placeholder="Name"]')).toBeNull();
    expect(container.querySelector('input[placeholder="Email"]')).toBeNull();
    expect(container.querySelector('input[placeholder="Password"]')).toBeNull();
  });

  it('비밀번호 규칙 카운트({count}/3)가 실제 값으로 보간된다 — 빈 자리표시자로 안 남는다', async () => {
    await mount('ko');
    const pwInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => { setNativeValue(pwInput, 'Abc123!!'); });
    expect(container.textContent).toContain('4/3'); // upper+lower+digit+special 전부 충족
    expect(container.textContent).not.toContain('{count}');
  });

  it('en locale에선 영문 그대로 렌더된다(회귀 없음 — ko만 고치고 en을 안 깨뜨렸는지)', async () => {
    await mount('en');
    expect(container.textContent).toContain('Create your account');
    expect(container.textContent).toContain('Sign up');
  });
});

// story #2484 — error.code 분기 없이 json.error?.message를 그대로 쓰면 raw 서버 문자열이
// 샌다. code가 있으면 번역 문구, 없으면 안전 폴백(registrationFailed)만 떠야 한다.
describe('RegisterPage — error.code 분기 (story #2484)', () => {
  async function fillAndSubmit() {
    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const pwInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    const tosCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(nameInput, 'Test User');
      setNativeValue(emailInput, 'a@b.com');
      setNativeValue(pwInput, 'Abc123!!');
      tosCheckbox.click();
    });
    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.register.submit);
    await act(async () => {
      submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it('EMAIL_TAKEN — raw 영문 대신 번역 문구', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'EMAIL_TAKEN', message: 'Email already registered' } }),
    })));
    await mount('ko');
    await fillAndSubmit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toContain('Email already registered');
    expect(alertEl?.textContent).toBe(koMessages.register.registerEmailTaken);
  });

  it('알려지지 않은 code — 안전 폴백, raw message 미노출', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'SOME_NEW_CODE', message: 'brand new raw string' } }),
    })));
    await mount('ko');
    await fillAndSubmit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toContain('brand new raw string');
    expect(alertEl?.textContent).toBe(koMessages.register.registrationFailed);
  });
});

// story #3204(acquisition 계측) — 가입 완료 시 목적지 URL에 sign_up 이벤트 발화 신호
// (?signup=1)를 붙인다. OAuth 경로(api/auth/callback/[provider]/route.ts)와 동일
// 파라미터로 통일해 google-analytics.tsx 한 곳에서만 발화하는 SSOT 계약.
describe('RegisterPage — sign_up 이벤트 발화 신호(story #3204)', () => {
  afterEach(() => { vi.unstubAllGlobals(); pushMock.mockClear(); });

  async function fillAndSubmit() {
    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const pwInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    const tosCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(nameInput, 'Test User');
      setNativeValue(emailInput, 'a@b.com');
      setNativeValue(pwInput, 'Abc123!!');
      tosCheckbox.click();
    });
    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.register.submit);
    await act(async () => {
      submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('가입 성공 → org_id 있으면 /inbox?signup=1로 이동', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/register') return { ok: true, json: async () => ({ data: { ok: true } }) };
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { org_id: 'org-1' } }) };
      return { ok: false, json: async () => ({}) };
    }));
    await mount('ko');
    await fillAndSubmit();
    expect(pushMock).toHaveBeenCalledWith('/inbox?signup=1');
  });

  it('가입 성공 → org_id 없으면 /onboarding?signup=1로 이동', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/register') return { ok: true, json: async () => ({ data: { ok: true } }) };
      if (url === '/api/me') return { ok: true, json: async () => ({ data: {} }) };
      return { ok: false, json: async () => ({}) };
    }));
    await mount('ko');
    await fillAndSubmit();
    expect(pushMock).toHaveBeenCalledWith('/onboarding?signup=1');
  });
});

// story #3220 — 비로그인 초대수락→가입 여정: register 완료 후 org_id 유무만 보고
// /inbox·/onboarding으로 무조건 미는 대신, next(예: /invite/accept?token=…)가 있으면
// 그쪽을 우선 복귀시켜야 초대받은 사람이 자기 조직을 만드는 대신 초대받은 조직에
// 합류할 수 있다.
describe('RegisterPage — next 우선 복귀(story #3220, 초대수락 여정 단절 fix)', () => {
  afterEach(() => { vi.unstubAllGlobals(); pushMock.mockClear(); });

  async function fillAndSubmit() {
    const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
    const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    const pwInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    const tosCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(nameInput, 'Test User');
      setNativeValue(emailInput, 'a@b.com');
      setNativeValue(pwInput, 'Abc123!!');
      tosCheckbox.click();
    });
    const submitBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.register.submit);
    await act(async () => {
      submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('next가 있으면 org_id 유무와 무관하게 next로 복귀 — 쿼리스트링 구분자(&)도 정확히 붙는다', async () => {
    searchParamsRef.current = new URLSearchParams(
      `next=${encodeURIComponent('/invite/accept?token=abc123')}`
    );
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/register') return { ok: true, json: async () => ({ data: { ok: true } }) };
      // org_id가 있어도(재가입 엣지케이스와 무관 — 이 값과 무관하게 next 우선) next가 이긴다.
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { org_id: 'org-1' } }) };
      return { ok: false, json: async () => ({}) };
    }));
    await mount('ko');
    await fillAndSubmit();
    expect(pushMock).toHaveBeenCalledWith('/invite/accept?token=abc123&signup=1');
  });

  it('next가 오픈 리다이렉트 가드에 걸리면(외부 도메인) safeNextPath 폴백(/chats)으로 안전 하강', async () => {
    searchParamsRef.current = new URLSearchParams(`next=${encodeURIComponent('//evil.com')}`);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/register') return { ok: true, json: async () => ({ data: { ok: true } }) };
      if (url === '/api/me') return { ok: true, json: async () => ({ data: {} }) };
      return { ok: false, json: async () => ({}) };
    }));
    await mount('ko');
    await fillAndSubmit();
    expect(pushMock).toHaveBeenCalledWith('/chats?signup=1');
  });

  it('next가 없으면 예전처럼 org_id 분기만 적용 — 회귀 없음', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/register') return { ok: true, json: async () => ({ data: { ok: true } }) };
      if (url === '/api/me') return { ok: true, json: async () => ({ data: {} }) };
      return { ok: false, json: async () => ({}) };
    }));
    await mount('ko');
    await fillAndSubmit();
    expect(pushMock).toHaveBeenCalledWith('/onboarding?signup=1');
  });
});

// story #3220(fix-on-sight) — Google OAuth 버튼도 login 페이지의 OAuth 버튼들과 같은
// 결함(next 미전파)이 있었다. NEXT_PUBLIC_OAUTH_ENABLED가 있어야 버튼 자체가 렌더된다.
describe('RegisterPage — Google OAuth 링크 next 전파(story #3220)', () => {
  const originalOauthEnabled = process.env['NEXT_PUBLIC_OAUTH_ENABLED'];
  beforeEach(() => { process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = 'true'; });
  afterEach(() => { process.env['NEXT_PUBLIC_OAUTH_ENABLED'] = originalOauthEnabled; });

  it('next가 있고 ToS 동의 상태면 Google 링크가 next를 실어 나른다', async () => {
    searchParamsRef.current = new URLSearchParams(
      `next=${encodeURIComponent('/invite/accept?token=abc123')}`
    );
    await mount('ko');
    const tosCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { tosCheckbox.click(); });
    const googleLink = [...container.querySelectorAll('a')].find((a) => a.href.includes('provider=google'));
    expect(googleLink?.getAttribute('href')).toBe(
      `/auth/login?provider=google&tos_accepted=true&next=${encodeURIComponent('/invite/accept?token=abc123')}`
    );
  });
});
