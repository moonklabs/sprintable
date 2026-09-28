// @vitest-environment jsdom
// story #4372 — 검증 예시 프롬프트 복사 실패 패널(connect-step · 채용 화면 공용). 실패일 때만 · 전체 문구 선택 가능 · ✕ · 바깥 클릭 · Esc로 닫힘.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { VerifyPromptCopyFailedPanel } from './verify-prompt-copy-failed-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function render(failed: boolean, onDismiss = vi.fn()) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages}>
        <VerifyPromptCopyFailedPanel failed={failed} onDismiss={onDismiss} promptText="검증 도구를 불러 주세요" rawTestId="raw" />
      </NextIntlClientProvider>,
    );
  });
  return onDismiss;
}

describe('VerifyPromptCopyFailedPanel — story #4372', () => {
  it('실패가 아니면 아무것도 그리지 않는다', async () => {
    await render(false);
    expect(container.innerHTML).toBe('');
  });

  it('⭐실패면 알림 문구 + 전체 문구 입력(선택 가능)', async () => {
    await render(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(koMessages.common.copyFailedSelectManually);
    expect((container.querySelector('[data-testid="raw"]') as HTMLInputElement).value).toBe('검증 도구를 불러 주세요');
  });

  it('✕ · Esc · 바깥 클릭이면 닫기를 부른다(안쪽 클릭은 아님)', async () => {
    const onDismiss = await render(true);
    await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="${koMessages.common.close}"]`)!.click(); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    await act(async () => { container.querySelector('[data-testid="raw"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });
});
