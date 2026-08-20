// @vitest-environment jsdom
//
// story #2844 — goal done 전이 outcome 판정 다이얼로그. 3택(hit/miss/unmeasurable)+근거 강제+
// no-fiction 스킵 경고를 실 렌더로 왕복 검증한다.
//
// ⚠️Dialog(base-ui DialogPortal)는 mount container가 아니라 document.body에 직접 포탈된다 —
// 그래서 이 테스트는 로컬 `container`가 아니라 `document.body`를 조회 대상으로 쓴다(container를
// 조회하면 포탈된 다이얼로그 콘텐츠를 영원히 못 찾는다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { GoalOutcomeDialog, type GoalOutcomeSubmission } from './goal-outcome-dialog';

let mountPoint: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  mountPoint = document.createElement('div');
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  mountPoint.remove();
});

function clickByText(text: string) {
  const el = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`button not found: ${text}`);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function setInputValue(id: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`input not found: ${id}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('GoalOutcomeDialog', () => {
  it('choice 단계에 3택+스킵 링크가 모두 보인다', async () => {
    await act(async () => {
      root.render(wrap(<GoalOutcomeDialog goalTitle="결제 전환율 20%" submitting={false} onSubmit={() => {}} onCancel={() => {}} />));
    });
    expect(document.body.textContent).toContain(koMessages.goals.outcomeChoiceHit);
    expect(document.body.textContent).toContain(koMessages.goals.outcomeChoiceMiss);
    expect(document.body.textContent).toContain(koMessages.goals.outcomeChoiceUnmeasurable);
    expect(document.body.textContent).toContain(koMessages.goals.outcomeSkipLink);
  });

  // soul-lock(hypothesis-status-badge.tsx §12.1과 동형) — miss·unmeasurable도 destructive(빨강) 금지.
  it('miss·unmeasurable 버튼에 destructive 클래스가 없다(soul-lock)', async () => {
    await act(async () => {
      root.render(wrap(<GoalOutcomeDialog goalTitle="X" submitting={false} onSubmit={() => {}} onCancel={() => {}} />));
    });
    const buttons = Array.from(document.body.querySelectorAll('button'));
    const missBtn = buttons.find((b) => b.textContent?.trim() === koMessages.goals.outcomeChoiceMiss);
    const unmeasurableBtn = buttons.find((b) => b.textContent?.trim() === koMessages.goals.outcomeChoiceUnmeasurable);
    expect(missBtn?.className).not.toMatch(/bg-destructive|border-destructive/);
    expect(unmeasurableBtn?.className).not.toMatch(/bg-destructive|border-destructive/);
    expect(missBtn?.className).toMatch(/info/);
    expect(unmeasurableBtn?.className).toMatch(/info/);
  });

  it('hit 선택 → 수치+근거 둘 다 있어야 제출 가능, 제출 시 정확한 payload를 낸다', async () => {
    const onSubmit = vi.fn<(r: GoalOutcomeSubmission) => void>();
    await act(async () => {
      root.render(wrap(<GoalOutcomeDialog goalTitle="X" submitting={false} onSubmit={onSubmit} onCancel={() => {}} />));
    });
    await act(async () => { clickByText(koMessages.goals.outcomeChoiceHit); });

    const submitBtn = () => Array.from(document.body.querySelectorAll('button[type="submit"]'))[0] as HTMLButtonElement;
    expect(submitBtn().disabled).toBe(true); // 아직 입력 전

    await act(async () => { setInputValue('goal-outcome-actual', '42'); });
    expect(submitBtn().disabled).toBe(true); // 수치만으론 부족(근거 없음)

    await act(async () => { setInputValue('goal-outcome-reason', '목표치 초과 달성'); });
    expect(submitBtn().disabled).toBe(false);

    await act(async () => { submitBtn().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(onSubmit).toHaveBeenCalledWith({ outcome_status: 'hit', outcome_result: { actual: 42, reason: '목표치 초과 달성' } });
  });

  it('unmeasurable 선택 → 수치 입력란 자체가 없고 근거만 요구된다', async () => {
    const onSubmit = vi.fn<(r: GoalOutcomeSubmission) => void>();
    await act(async () => {
      root.render(wrap(<GoalOutcomeDialog goalTitle="X" submitting={false} onSubmit={onSubmit} onCancel={() => {}} />));
    });
    await act(async () => { clickByText(koMessages.goals.outcomeChoiceUnmeasurable); });

    expect(document.body.querySelector('#goal-outcome-actual')).toBeNull(); // "측정 불가"인데 수치란이 있으면 모순
    const submitBtn = () => Array.from(document.body.querySelectorAll('button[type="submit"]'))[0] as HTMLButtonElement;
    expect(submitBtn().disabled).toBe(true);

    await act(async () => { setInputValue('goal-outcome-unmeasurable-reason', 'A/B 테스트 인프라 미비'); });
    expect(submitBtn().disabled).toBe(false);
    await act(async () => { submitBtn().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(onSubmit).toHaveBeenCalledWith({ outcome_status: 'unmeasurable', outcome_result: { reason: 'A/B 테스트 인프라 미비' } });
  });

  // no-fiction(#2843 AC2 PO 확定) — 스킵은 막지 않되 침묵 스킵은 금지. 경고를 보여준 뒤에만 확정.
  it('판정 없이 닫기 → 경고 문구가 먼저 뜨고, 확認해야만 onSubmit({skipped:true})이 불린다', async () => {
    const onSubmit = vi.fn<(r: GoalOutcomeSubmission) => void>();
    await act(async () => {
      root.render(wrap(<GoalOutcomeDialog goalTitle="X" submitting={false} onSubmit={onSubmit} onCancel={() => {}} />));
    });
    await act(async () => { clickByText(koMessages.goals.outcomeSkipLink); });
    expect(onSubmit).not.toHaveBeenCalled(); // 링크 클릭 자체는 아직 스킵을 확정하지 않는다
    expect(document.body.textContent).toContain(koMessages.goals.outcomeSkipWarning);

    await act(async () => { clickByText(koMessages.goals.outcomeSkipConfirm); });
    expect(onSubmit).toHaveBeenCalledWith({ skipped: true });
  });

  it('goalTitle이 화면에 그대로 노출된다(어떤 goal을 닫는지 보여야 함)', async () => {
    await act(async () => {
      root.render(wrap(<GoalOutcomeDialog goalTitle="온보딩 완료율 개선" submitting={false} onSubmit={() => {}} onCancel={() => {}} />));
    });
    expect(document.body.textContent).toContain('온보딩 완료율 개선');
  });
});
