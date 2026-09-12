// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { ApiUsageBudgetIndicator, type ApiUsageBudgetState } from './api-usage-budget-indicator';

// story #3808(Phase3·3-3 PR5a, 페드루 PO 確定 2026-09-12) —
// generation-budget-indicator.test.tsx와 동형 구조(형제 컴포넌트 회귀). 통화 변환
// 유틸(formatMinorCurrency/majorToMinor/minorToMajor) 자체는 그 파일에서 이미
// 검증됨(재사용, 중복 재발명 금지) — 이 파일은 ApiUsageBudgetIndicator 고유 분기
// (i18n 키가 apiUsageBudget*로 갈리는지)만 잰다.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function renderIndicator(state: ApiUsageBudgetState, variant: 'full' | 'compact' = 'full') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <ApiUsageBudgetIndicator state={state} variant={variant} />
      </NextIntlClientProvider>,
    );
  });
}

async function renderIndicatorEn(state: ApiUsageBudgetState, variant: 'full' | 'compact' = 'full') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <ApiUsageBudgetIndicator state={state} variant={variant} />
      </NextIntlClientProvider>,
    );
  });
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe('ApiUsageBudgetIndicator (story #3808 PR5a — X 종량 API 지출 월 상한 잔량 표시)', () => {
  it('loading — GenerationBudgetIndicator와 동형(공용 "—" 재사용)', async () => {
    await renderIndicator({ status: 'loading' });
    expect(byTestId('api-usage-budget-loading')?.textContent).toBe(koMessages.content.originAuthorUnknown);
  });

  it('failed(full=카드) — apiUsageBudget 전용 문구(generationBudget과 다른 키)', async () => {
    await renderIndicator({ status: 'failed' }, 'full');
    expect(byTestId('api-usage-budget-failed')?.textContent).toBe(koMessages.content.apiUsageBudgetCardCheckFailed);
    expect(byTestId('api-usage-budget-failed')?.textContent).not.toBe(koMessages.content.generationBudgetCardCheckFailed);
  });

  it('failed(compact=상신표면)', async () => {
    await renderIndicator({ status: 'failed' }, 'compact');
    expect(byTestId('api-usage-budget-failed')?.textContent).toBe(koMessages.content.apiUsageBudgetSubmitCheckFailed);
  });

  it('ok + limitMinor=null — 정책 미설정, 아무것도 그리지 않는다(0으로 지어내지 않는다)', async () => {
    await renderIndicator({
      status: 'ok', limitMinor: null, spentMinor: 0, remainingMinor: null, currency: null, period: 'month',
    });
    expect(container.innerHTML).toBe('');
  });

  it('ok + limitMinor=0 — 축 이름·0 한도·정지 대상 셋 다 한 줄에(유나 04:17Z 확定 문구)', async () => {
    await renderIndicator({
      status: 'ok', limitMinor: 0, spentMinor: 0, remainingMinor: 0, currency: 'KRW', period: 'month',
    });
    const el = byTestId('api-usage-budget-suspended');
    expect(el?.textContent).toBe('X 비용 한도 0원 · 발행 정지');
    expect(el?.className).not.toContain('destructive');
  });

  it('compact — 축 이름 접두 「X 비용 남음」(유나 04:12Z 지적 — 축 없이 서면 상단 생성예산과 헷갈림)', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 20000, remainingMinor: 80000, currency: 'KRW', period: 'month' },
      'compact',
    );
    const text = byTestId('api-usage-budget-remaining-compact')?.textContent ?? '';
    expect(text).toBe('X 비용 남음 80,000원');
    expect(text).not.toContain('100,000');
  });

  it('full — 한도(기간 접미사)·사용·남음 셋 다 독립된 값으로 보인다', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 20000, remainingMinor: 80000, currency: 'KRW', period: 'month' },
      'full',
    );
    const root2 = byTestId('api-usage-budget-remaining-full');
    expect(root2?.textContent).toContain('100,000원 / 월');
    expect(root2?.textContent).toContain('20,000원');
    expect(byTestId('api-usage-budget-remaining-value')?.textContent).toBe('80,000원');
  });

  it('⭐USD full — exponent 2가 세 값 전부에 적용된다(통화 유틸 재사용 회귀)', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 20000, remainingMinor: 80000, currency: 'USD', period: 'month' },
      'full',
    );
    const root2 = byTestId('api-usage-budget-remaining-full');
    expect(root2?.textContent).toContain('$1,000.00 / 월');
    expect(byTestId('api-usage-budget-remaining-value')?.textContent).toBe('$800.00');
  });

  it('remainingMinor가 null이면 failed와 동형으로 접는다(추정 조립 금지)', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 30000, remainingMinor: null, currency: 'USD', period: 'month' },
      'compact',
    );
    expect(byTestId('api-usage-budget-remaining-compact')).toBeNull();
    expect(byTestId('api-usage-budget-failed')?.textContent).toBe(koMessages.content.apiUsageBudgetSubmitCheckFailed);
  });

  it('currency가 null이면(limitMinor는 있음) failed와 동형으로 접는다', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 30000, remainingMinor: 70000, currency: null, period: 'month' },
      'full',
    );
    expect(byTestId('api-usage-budget-remaining-full')).toBeNull();
    expect(byTestId('api-usage-budget-failed')?.textContent).toBe(koMessages.content.apiUsageBudgetCardCheckFailed);
  });

  it('0원 잔량은 "정지"와 다르게 "X 비용 남음 0원"으로 그대로 그린다', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 100000, remainingMinor: 0, currency: 'KRW', period: 'month' },
      'compact',
    );
    expect(byTestId('api-usage-budget-remaining-compact')?.textContent).toBe('X 비용 남음 0원');
    expect(byTestId('api-usage-budget-suspended')).toBeNull();
  });

  it('⭐USD 정지 — 한도 표시가 통화 유틸을 그대로 타서 "$0.00"로 뜬다(하드코딩 "0원" 아님)', async () => {
    await renderIndicator({
      status: 'ok', limitMinor: 0, spentMinor: 0, remainingMinor: 0, currency: 'USD', period: 'month',
    });
    expect(byTestId('api-usage-budget-suspended')?.textContent).toBe('X 비용 한도 $0.00 · 발행 정지');
  });
});

describe('ApiUsageBudgetIndicator — en 로케일 실 메시지 파일 렌더(통화 유틸 재사용 회귀)', () => {
  it('KRW 카드 헤더가 en에서 "원"이 아니라 "₩"로 뜬다', async () => {
    await renderIndicatorEn(
      { status: 'ok', limitMinor: 100000, spentMinor: 0, remainingMinor: 100000, currency: 'KRW', period: 'month' },
      'full',
    );
    const text = byTestId('api-usage-budget-remaining-full')?.textContent ?? '';
    expect(text).toContain('₩100,000');
    expect(text).not.toContain('원');
  });

  it('USD는 en에서도 "$"', async () => {
    await renderIndicatorEn(
      { status: 'ok', limitMinor: 50000, spentMinor: 0, remainingMinor: 50000, currency: 'USD', period: 'month' },
      'compact',
    );
    expect(byTestId('api-usage-budget-remaining-compact')?.textContent).toBe('X cost $500.00 left');
  });

  it('en 정지 문구도 같은 축 이름("X cost")으로 선다', async () => {
    await renderIndicatorEn({
      status: 'ok', limitMinor: 0, spentMinor: 0, remainingMinor: 0, currency: 'KRW', period: 'month',
    });
    expect(byTestId('api-usage-budget-suspended')?.textContent).toBe('X cost limit ₩0 · Publishing paused');
  });
});
