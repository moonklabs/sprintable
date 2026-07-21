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

const { loginWithPasswordMock } = vi.hoisted(() => ({ loginWithPasswordMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ loginWithPassword: loginWithPasswordMock }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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
    expect(alertEl?.textContent).toBe('이메일 또는 비밀번호가 올바르지 않습니다.');
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
