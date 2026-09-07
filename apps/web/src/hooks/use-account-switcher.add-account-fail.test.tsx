// @vitest-environment jsdom
//
// story #3638(유나 §8 별건) — handleAdd(계정 추가)가 네트워크 예외로 실패하면 busy
// 스피너만 멈추고 조용했다(문구 0). addAccountFailed 신규 1키 — error 상태는 이미
// profile-menu.tsx/context-switcher-chip.tsx 둘 다 렌더하고 있어(role=alert) 배선만
// 하면 된다. 훅을 직접 마운트하는 최소 하네스로 검증(전체 UI 조립 없이).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import { useAccountSwitcher } from './use-account-switcher';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Harness() {
  const acc = useAccountSwitcher('나');
  return (
    <div>
      <button type="button" onClick={() => void acc.handleAdd()}>추가</button>
      {acc.error ? <p role="alert">{acc.error}</p> : null}
    </div>
  );
}

function wrap() {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <Harness />
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

describe('useAccountSwitcher — 계정 추가 네트워크 실패 시 문장(story #3638)', () => {
  it('handleAdd이 예외를 던지면 addAccountFailed가 뜬다(구 조용한 busy 해제)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await act(async () => { root.render(wrap()); });

    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain(koMessages.accountSwitcher.addAccountFailed);
  });
});
