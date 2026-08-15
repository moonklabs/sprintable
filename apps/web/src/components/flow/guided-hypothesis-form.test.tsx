// @vitest-environment jsdom
//
// story #2543(#2542 FE 이관, 유나 SSOT ae75a8ff) — guided 3부 폼. 예시 칩 prefill이 statement·
// metric·target·direction 전부를 한 번에 채우고, 제출은 정확히 {statement, metric, target,
// direction} 4필드만 onSubmit으로 올리는지(project_id는 호출부가 붙인다) 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { GuidedHypothesisForm } from './guided-hypothesis-form';

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
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function findButtonByText(text: string) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
}

describe('GuidedHypothesisForm', () => {
  it('빈 상태에서는 제출 버튼이 비활성이다', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(wrap(<GuidedHypothesisForm onSubmit={onSubmit} onCancel={vi.fn()} />));
    });

    const submitBtn = findButtonByText(koMessages.flow.guidedSubmit) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it('예시 칩을 고르면 statement·metric·target·direction이 한 번에 채워지고 제출 시 그대로 전달된다', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(wrap(<GuidedHypothesisForm onSubmit={onSubmit} onCancel={vi.fn()} />));
    });

    const chip = findButtonByText(koMessages.flow.guidedExampleReviewAgent);
    expect(chip).toBeTruthy();
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const statementEl = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(statementEl.value).toBe(koMessages.flow.guidedExampleReviewAgentStatement);

    const submitBtn = findButtonByText(koMessages.flow.guidedSubmit) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    const form = container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith({
      statement: koMessages.flow.guidedExampleReviewAgentStatement,
      metric: koMessages.flow.guidedExampleReviewAgentMetric,
      target: 5,
      direction: 'down',
    });
  });

  it('취소 버튼은 onCancel을 부른다', async () => {
    const onCancel = vi.fn();
    await act(async () => {
      root.render(wrap(<GuidedHypothesisForm onSubmit={vi.fn()} onCancel={onCancel} />));
    });

    const cancelBtn = findButtonByText(koMessages.flow.guidedCancel);
    await act(async () => {
      cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onCancel).toHaveBeenCalled();
  });
});
