// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import {
  GenerationBudgetIndicator, formatMinorCurrency, majorToMinor, minorToMajor,
  type GenerationBudgetState,
} from './generation-budget-indicator';

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

async function renderIndicator(state: GenerationBudgetState, variant: 'full' | 'compact' = 'full') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <GenerationBudgetIndicator state={state} variant={variant} />
      </NextIntlClientProvider>,
    );
  });
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe('formatMinorCurrency / majorToMinor / minorToMajor (§19-1 — 통화 소수 자릿수, 최우선 회귀 방지)', () => {
  it('KRW — exponent 0, 콤마 포맷, 소수 없음', () => {
    expect(formatMinorCurrency(100000, 'KRW')).toBe('100,000원');
    expect(formatMinorCurrency(0, 'KRW')).toBe('0원');
  });

  it('⭐USD — exponent 2, "$"+소수 2자리(하드코딩 /100을 빼먹으면 이 값이 100배로 튄다)', () => {
    expect(formatMinorCurrency(50000, 'USD')).toBe('$500.00');
    expect(formatMinorCurrency(150, 'USD')).toBe('$1.50');
    expect(formatMinorCurrency(5, 'USD')).toBe('$0.05');
  });

  it('majorToMinor/minorToMajor — KRW는 항등(exponent 0), USD는 ×100/÷100', () => {
    expect(majorToMinor(500, 'KRW')).toBe(500);
    expect(minorToMajor(500, 'KRW')).toBe(500);
    expect(majorToMinor(500, 'USD')).toBe(50000);
    expect(minorToMajor(50000, 'USD')).toBe(500);
  });
});

describe('GenerationBudgetIndicator (story #3500, doc a0da40c9 §19 — BE #3498 미착지, 계약 fixture)', () => {
  it('loading — 이 파일 전용 키를 새로 안 만들고 공용 "—"(originAuthorUnknown)를 재사용한다(§19-4)', async () => {
    await renderIndicator({ status: 'loading' });
    expect(byTestId('generation-budget-loading')?.textContent).toBe(koMessages.content.originAuthorUnknown);
  });

  it('failed(full=카드) — 카드 전용 문구', async () => {
    await renderIndicator({ status: 'failed' }, 'full');
    expect(byTestId('generation-budget-failed')?.textContent).toBe(koMessages.content.generationBudgetCardCheckFailed);
  });

  it('failed(compact=상신표면) — 다른 문구(주어 필요, §19-4 — 게시한도 표시와 헷갈리지 않게)', async () => {
    await renderIndicator({ status: 'failed' }, 'compact');
    expect(byTestId('generation-budget-failed')?.textContent).toBe(koMessages.content.generationBudgetSubmitCheckFailed);
  });

  it('ok + limitMinor=null — 정책 미설정, 아무것도 그리지 않는다(§19-3 — "—"도 "0"도 아님)', async () => {
    await renderIndicator({
      status: 'ok', limitMinor: null, spentMinor: 0, remainingMinor: null, currency: null, period: 'month',
    });
    expect(container.innerHTML).toBe('');
  });

  it('ok + limitMinor=0 — "정지"(destructive 아닌 중립 톤, §19-3)', async () => {
    await renderIndicator({
      status: 'ok', limitMinor: 0, spentMinor: 0, remainingMinor: 0, currency: 'KRW', period: 'month',
    });
    const el = byTestId('generation-budget-suspended');
    expect(el?.textContent).toBe('정지');
    expect(el?.className).not.toContain('destructive');
  });

  it('compact — "남음"만(한도는 안 보인다, 분수 아님 — §19-5)', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 20000, remainingMinor: 80000, currency: 'KRW', period: 'month' },
      'compact',
    );
    const text = byTestId('generation-budget-remaining-compact')?.textContent ?? '';
    expect(text).toBe('남음 80,000원');
    expect(text).not.toContain('100,000'); // 한도 값이 안 섞여 나온다(분수 아님)
  });

  it('full — 한도(기간 접미사)·사용·남음 셋 다 독립된 값으로 보인다(§19-5, 분수 아님)', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 20000, remainingMinor: 80000, currency: 'KRW', period: 'month' },
      'full',
    );
    const root2 = byTestId('generation-budget-remaining-full');
    expect(root2?.textContent).toContain('100,000원 / 월');
    expect(root2?.textContent).toContain('20,000원');
    expect(byTestId('generation-budget-remaining-value')?.textContent).toBe('80,000원');
  });

  it('⭐USD full — exponent 2가 세 값(한도·사용·남음) 전부에 적용된다', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 20000, remainingMinor: 80000, currency: 'USD', period: 'month' },
      'full',
    );
    const root2 = byTestId('generation-budget-remaining-full');
    expect(root2?.textContent).toContain('$1,000.00 / 월');
    expect(root2?.textContent).toContain('$200.00');
    expect(byTestId('generation-budget-remaining-value')?.textContent).toBe('$800.00');
  });

  it('remainingMinor가 없으면 limitMinor-spentMinor로 직접 계산한다', async () => {
    await renderIndicator(
      // @ts-expect-error — remainingMinor 누락 케이스를 의도적으로 시뮬레이션
      { status: 'ok', limitMinor: 100000, spentMinor: 30000, currency: 'USD', period: 'month' },
      'compact',
    );
    expect(byTestId('generation-budget-remaining-compact')?.textContent).toBe('남음 $700.00');
  });

  it('0원 잔량(양수 한도 전부 소진)은 "정지"와 다르게, "남음 0원"으로 그대로 그린다(§19-3)', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 100000, remainingMinor: 0, currency: 'KRW', period: 'month' },
      'compact',
    );
    expect(byTestId('generation-budget-remaining-compact')?.textContent).toBe('남음 0원');
    expect(byTestId('generation-budget-suspended')).toBeNull();
  });
});
