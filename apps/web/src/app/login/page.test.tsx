// @vitest-environment jsdom
//
// story #2105 1차 — 로그인은 계정 없는 사람이 제품에서 처음 만나는 화면 중 하나인데 실패
// 사유가 role·aria-live 없이 순수 시각 요소로만 렌더됐다(#2096과 같은 결함클래스). 재시도마다
// setError(null)이 먼저 실행돼 이 단락이 매번 언마운트→리마운트되므로, 동일한 실패 사유가
// 연속으로 떠도 새 DOM 노드로 안착해 스크린리더가 놓치지 않는다 — 그 왕복까지 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

// story #3220 — searchParamsRef를 vi.hoisted로 노출해 테스트별로 next 파라미터를
// 갈아끼울 수 있게 한다(기존엔 매 호출 새 빈 URLSearchParams라 next 유무를 테스트할
// 방법이 없었음). beforeEach에서 빈 값으로 리셋 — 다른 기존 테스트엔 무회귀.
const { loginWithPasswordMock, searchParamsRef } = vi.hoisted(() => ({
  loginWithPasswordMock: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}));
vi.mock('@/lib/db/client', () => ({ loginWithPassword: loginWithPasswordMock }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParamsRef.current,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  loginWithPasswordMock.mockReset();
  searchParamsRef.current = new URLSearchParams();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.resetModules();
});

async function mount() {
  const { default: LoginPage } = await import('./page');
  await act(async () => { root.render(wrap(<LoginPage />)); });
}

function setNativeValue(el: HTMLInputElement, value: string) {
  // React controlled input을 jsdom에서 신뢰성 있게 채우는 표준 우회 — 네이티브 value setter를
  // 직접 호출해야 React의 내부 값 추적(valueTracker)이 실제 변경으로 인식한다(단순
  // `el.value = ...` + dispatchEvent만으로는 종종 무시된다).
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit() {
  const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
  const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    setNativeValue(emailInput, 'a@b.com');
    setNativeValue(passwordInput, 'wrong');
  });
  const signInBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.login.signIn);
  await act(async () => {
    signInBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('LoginPage — 실패 사유 접근성 (story #2105 1차)', () => {
  it('로그인 실패 시 role="alert" aria-live="assertive"로 사유가 렌더된다', async () => {
    loginWithPasswordMock.mockResolvedValue({ error: { code: 'INVALID_CREDENTIALS', message: '이메일 또는 비밀번호가 올바르지 않습니다.' } });
    await mount();
    await submit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    // story #3901 — 렌더된 문구는 t('loginInvalidCredentials')이지 mock의 message 필드가
    // 아니다(컴포넌트가 code로 분기·raw message 미사용) — 리터럴 재-pin 대신 ko.json 값 대조.
    expect(alertEl?.textContent).toBe(koMessages.login.loginInvalidCredentials);
    expect(alertEl?.getAttribute('aria-live')).toBe('assertive');
  });

  it('동일한 실패 사유가 연속으로 떠도 매번 새 DOM 노드로 안착한다(setError(null) 선-리셋 확認)', async () => {
    loginWithPasswordMock.mockResolvedValue({ error: { code: 'INVALID_CREDENTIALS', message: '이메일 또는 비밀번호가 올바르지 않습니다.' } });
    await mount();
    await submit();
    const first = container.querySelector('[role="alert"]');
    expect(first).not.toBeNull();

    await submit();
    const second = container.querySelector('[role="alert"]');
    expect(second).not.toBeNull();
    // 서로 다른 DOM 노드여야 한다 — 같은 노드가 재사용되면 텍스트가 안 바뀌어 스크린리더가
    // 못 알아챌 수 있다. 언마운트→리마운트를 거쳤다면 두 참조는 동일 객체가 아니다.
    expect(first).not.toBe(second);
  });
});

// story #2484 — code로 분기하지 않으면 result.error.message(서버/BFF raw 영문)가 그대로
// 뜬다. 각 케이스에서 raw 영문 message는 화면에 없어야 하고, 대신 번역된 한국어 문구가
// 떠야 한다(메시지를 일부러 실제와 다른 raw 영문으로 줘서 "raw가 새면 바로 드러나게" 함).
describe('LoginPage — error.code 분기 (story #2484)', () => {
  it('ACCOUNT_LOCKED — raw 영문 대신 번역 문구', async () => {
    loginWithPasswordMock.mockResolvedValue({ error: { code: 'ACCOUNT_LOCKED', message: 'Account locked. Try again in 287 seconds' } });
    await mount();
    await submit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toContain('Account locked');
    expect(alertEl?.textContent).toBe(koMessages.login.loginAccountLocked);
  });

  it('TOTP_LOCKED — raw 영문 대신 번역 문구', async () => {
    loginWithPasswordMock.mockResolvedValue({ error: { code: 'TOTP_LOCKED', message: 'Too many failures. Retry after 300s' } });
    await mount();
    await submit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toContain('Too many failures');
    expect(alertEl?.textContent).toBe(koMessages.login.loginTotpLocked);
  });

  it('INVALID_TOTP — raw 영문 대신 번역 문구', async () => {
    loginWithPasswordMock.mockResolvedValue({ error: { code: 'INVALID_TOTP', message: 'Invalid TOTP code' } });
    await mount();
    await submit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toContain('Invalid TOTP');
    expect(alertEl?.textContent).toBe(koMessages.login.loginInvalidTotpCode);
  });

  it('알려지지 않은 code — 안전 폴백(loginFailed), raw message 미노출', async () => {
    loginWithPasswordMock.mockResolvedValue({ error: { code: 'SOME_NEW_BACKEND_CODE', message: 'a brand new raw server string' } });
    await mount();
    await submit();
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).not.toContain('brand new raw server string');
    expect(alertEl?.textContent).toBe(koMessages.login.loginFailed);
  });

  // 양성대조(AC) — 가드 없이 raw message를 그대로 쓰면 이 테스트가 RED여야 한다.
  // (수동 mutation self-check로 확認 — 아래 PR 설명 참고. 이 테스트 자체가 그 반례 역할.)
});

// story #3220 — 비로그인 초대수락→회원가입 경로가 여기서 끊겼다: login 페이지 자체는
// next를 이미 들고 있는데 "회원가입" 링크가 그걸 안 실어 register로 못 넘겼다.
describe('LoginPage — 회원가입 링크 next 전파(story #3220, 초대수락 여정 단절 fix)', () => {
  it('next 파라미터가 있으면 회원가입 링크가 그대로 실어 나른다', async () => {
    searchParamsRef.current = new URLSearchParams(
      `next=${encodeURIComponent('/invite/accept?token=abc123')}`
    );
    await mount();
    const signUpLink = [...container.querySelectorAll('a')].find(
      (a) => a.textContent === koMessages.login.signUp
    );
    expect(signUpLink?.getAttribute('href')).toBe(
      `/register?next=${encodeURIComponent('/invite/accept?token=abc123')}`
    );
  });

  it('next가 없으면 예전처럼 맨몸 /register — 회귀 없음', async () => {
    await mount();
    const signUpLink = [...container.querySelectorAll('a')].find(
      (a) => a.textContent === koMessages.login.signUp
    );
    expect(signUpLink?.getAttribute('href')).toBe('/register');
  });
});

describe('story #4318 — 로그인 화면 링크 글자는 brand-text(밝은 7.05 · muted 6.63) · text-brand(4.35 · 4.09) 아님', () => {
  it('⭐비밀번호 찾기 · 가입 링크 — text-brand-text · hover /85 · 로고만 text-brand', async () => {
    await mount();
    const links = [...container.querySelectorAll('a')].filter((a) => ['/forgot-password', '/register'].some((h) => (a.getAttribute('href') ?? '').startsWith(h)));
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const a of links) {
      const cls = a.className.split(/\s+/);
      expect(cls).toContain('text-brand-text');
      expect(cls).toContain('hover:text-brand-text/85');
      expect(cls).not.toContain('text-brand');
    }
  });
});

// story #4763 AC6 — the first screen of a person with no account: one sentence on what this is and the way to the Mac app, only where the download exists and on a Mac.
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function mountWithOffer(enabled: boolean, ua = MAC) {
  vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => ua);
  const { default: LoginPage } = await import('./page');
  const { MacAppOfferProvider } = await import('./mac-app-offer');
  await act(async () => { root.render(wrap(<MacAppOfferProvider enabled={enabled}><LoginPage /></MacAppOfferProvider>)); });
}
const offer = () => container.querySelector('[data-testid="login-mac-app-offer"]');

describe('LoginPage — 첫 화면의 «Mac 앱 받기» (story #4763 AC6)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('받기가 있는 배포 · Mac: 제품 한 문장 + «Mac 앱 받기» = 가입 없이 파일로 가는 공개 링크(가입은 앱에서 이어짐) + 웹 가입은 둘째 링크로 남음 (story #4763 · PO 10-26)', async () => {
    await mountWithOffer(true);
    expect(offer()).not.toBeNull();
    expect(offer()?.textContent).toContain(koMessages.login.macAppPitch);
    expect(offer()?.textContent).toContain(koMessages.login.macAppGetHint);
    const links = [...(offer()?.querySelectorAll('a') ?? [])];
    const get = links.find((a) => a.textContent === koMessages.login.macAppGet);
    expect(get?.getAttribute('href')).toBe('/desktop/get/macos'); // the file itself — not the sign-up (the download used to stand behind the account + the e-mail check)
    const web = links.find((a) => a.textContent === koMessages.login.macAppWebSignup);
    expect(web?.getAttribute('href')).toBe('/register'); // the web sign-up stays for a person who would rather start there
    expect(links.filter((a) => a.getAttribute('href') === '/register')).toHaveLength(1);
    // the file is a .dmg: the hint says it is installed first and that the sign-up then continues in the app (no e-mail check before the file any more)
    expect(koMessages.login.macAppGetHint).toContain('설치');
    expect(koMessages.login.macAppGetHint).toContain('가입');
    expect(koMessages.login.macAppGetHint).not.toContain('메일 인증');
  });

  it('받기가 없는 배포(공증 전 prod · 컨텍스트 없음): 아무것도 안 뜬다 — 없는 길을 약속하지 않음', async () => {
    await mountWithOffer(false);
    expect(offer()).toBeNull();
    root.unmount(); root = createRoot(container);
    await mount(); // no provider at all
    expect(offer()).toBeNull();
    expect(container.textContent).not.toContain(koMessages.login.macAppGet);
  });

  it('Mac이 아닌 기기(폰 · 다른 OS)에는 안 뜬다 — 받을 수 없는 앱을 권하지 않음', async () => {
    await mountWithOffer(true, IPHONE);
    expect(offer()).toBeNull();
  });

  it('볼일이 있어 온 사람(next 있음 · 세션 만료)에겐 안 뜬다 — 로그인이 먼저', async () => {
    searchParamsRef.current = new URLSearchParams('next=%2Finvite%2Fabc');
    await mountWithOffer(true);
    expect(offer()).toBeNull();
    root.unmount(); root = createRoot(container);
    searchParamsRef.current = new URLSearchParams('reason=session_expired');
    await mountWithOffer(true);
    expect(offer()).toBeNull();
  });

  it('en.json에도 같은 키 셋이 있다(ko/en 짝)', async () => {
    const en = (await import('../../../messages/en.json')).default as { login: Record<string, string> };
    for (const k of ['macAppPitch', 'macAppGet', 'macAppGetHint', 'macAppWebSignup']) expect(typeof en.login[k]).toBe('string');
    expect(en.login.macAppGetHint).toContain('Install'); // the file is a .dmg — installed first
    expect(en.login.macAppGetHint).toContain('sign-up');
  });
});
