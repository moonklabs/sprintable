// @vitest-environment jsdom
//
// story #2096 — 토스트가 role·aria-live 없이 렌더돼 스크린리더가 아예 안 읽었다(까심군이
// #2384 검수 때 토스트를 자동으로 못 잡아 스크린샷으로만 확認한 원인). 토스트는 조작 결과를
// 알리는 유일한 수단인 경우가 많아(담당자 지정 성공 등) 접근성 결함이 곧 기능 결함이다.
//
// AC4 — data-testid로 우회하지 않는다: 여기서 쓰는 셀렉터는 [role="alert"]/[role="status"]
// 자체다. 접근성 속성이 곧 셀렉터라는 것을 테스트 스스로 증명한다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ToastContainer, type ToastItem } from './toast';
import koMessages from '../../../messages/ko.json';

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

function toast(overrides: Partial<ToastItem>): ToastItem {
  return { id: 't1', title: '제목', ...overrides };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('Toast 접근성 (story #2096)', () => {
  // AC2 — success/info/warning은 흐름을 끊지 않는 polite, error만 즉시 끼어드는 assertive.
  it.each([
    ['success', 'status', 'polite'],
    ['info', 'status', 'polite'],
    ['warning', 'status', 'polite'],
    [undefined, 'status', 'polite'],
    ['error', 'alert', 'assertive'],
  ] as const)('type=%s → role=%s, aria-live=%s', async (type, expectedRole, expectedLive) => {
    await act(async () => {
      root.render(wrap(
        <ToastContainer toasts={[toast({ type })]} onDismiss={() => {}} />,
      ));
    });
    const el = container.querySelector(`[role="${expectedRole}"]`);
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-live')).toBe(expectedLive);
    expect(el?.getAttribute('aria-atomic')).toBe('true');
  });

  it('error 토스트는 status가 아니라 alert로만 잡힌다(둘 다 걸리면 이중 낭독)', async () => {
    await act(async () => {
      root.render(wrap(<ToastContainer toasts={[toast({ type: 'error' })]} onDismiss={() => {}} />));
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('닫기 버튼에 접근 가능한 이름(aria-label)이 있다 — "✕" 문자만으론 스크린리더가 못 읽는다', async () => {
    await act(async () => {
      root.render(wrap(<ToastContainer toasts={[toast({})]} onDismiss={() => {}} />));
    });
    const dismissBtn = container.querySelector('button[aria-label]');
    expect(dismissBtn).not.toBeNull();
    expect(dismissBtn?.getAttribute('aria-label')).toBe(koMessages.common.close);
  });

  it('여러 토스트가 섞여도 각자 올바른 role로 각각 잡힌다', async () => {
    await act(async () => {
      root.render(wrap(
        <ToastContainer
          toasts={[toast({ id: 't1', type: 'success' }), toast({ id: 't2', type: 'error' })]}
          onDismiss={() => {}}
        />,
      ));
    });
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
    expect(container.querySelectorAll('[role="alert"]').length).toBe(1);
  });
});
