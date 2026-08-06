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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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
