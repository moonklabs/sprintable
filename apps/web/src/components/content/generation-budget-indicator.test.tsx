// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
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

async function renderIndicatorEn(state: GenerationBudgetState, variant: 'full' | 'compact' = 'full') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <GenerationBudgetIndicator state={state} variant={variant} />
      </NextIntlClientProvider>,
    );
  });
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

// PO REQUIRED①(2026-09-05, PR#3848 리뷰) — 단위/기호는 i18n 키
// (generationBudgetAmountKrw/Usd)를 거친다. 순수함수 단위 테스트라 실제
// next-intl 프로바이더 없이, 그 두 키의 ko.json 원문 그대로 보간하는 최소
// stub t로 검증한다(진짜 키 존재는 check-i18n-keys.js·렌더 테스트 쪽이 잡는다).
function stubT(key: string, values?: Record<string, string | number>): string {
  const templates: Record<string, string> = {
    generationBudgetAmountKrw: '{amount}원',
    generationBudgetAmountUsd: '${amount}',
  };
  const template = templates[key] ?? key;
  return template.replace('{amount}', String(values?.amount ?? ''));
}

describe('formatMinorCurrency / majorToMinor / minorToMajor (§19-1 — 통화 소수 자릿수, 최우선 회귀 방지)', () => {
  it('KRW — exponent 0, 콤마 포맷(로케일 기준), 소수 없음', () => {
    expect(formatMinorCurrency(100000, 'KRW', 'ko', stubT)).toBe('100,000원');
    expect(formatMinorCurrency(0, 'KRW', 'ko', stubT)).toBe('0원');
  });

  it('⭐USD — exponent 2, "$"+소수 2자리(하드코딩 /100을 빼먹으면 이 값이 100배로 튄다)', () => {
    expect(formatMinorCurrency(50000, 'USD', 'en', stubT)).toBe('$500.00');
    expect(formatMinorCurrency(150, 'USD', 'en', stubT)).toBe('$1.50');
    expect(formatMinorCurrency(5, 'USD', 'en', stubT)).toBe('$0.05');
  });

  it('⭐USD — locale이 en이 아니어도(ko UI에서 USD 조직 보는 경우) exponent는 통화가 정한다(로케일 무관)', () => {
    // §19-1의 핵심 불변식 — 숫자 묶음 방식은 로케일에 따라 달라질 수 있어도, 소수
    // 자릿수(exponent)는 오직 통화가 정한다. ko/en 둘 다 여기서 "$1.50"이어야 한다.
    expect(formatMinorCurrency(150, 'USD', 'ko', stubT)).toBe('$1.50');
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

  it('⭐PO REQUIRED②(2026-09-05) — remainingMinor가 null이면 limit-spent로 FE가 조립하지 않고 failed와 동형으로 접는다', async () => {
    // 옛 처방(FE가 `limitMinor - spentMinor`로 스스로 계산)을 되돌리면 이 테스트가
    // 다시 실패한다(생략 필드 대신 명시 null — remainingMinor는 number|null 필수
    // 필드다, undefined 시뮬레이션이 아니라 서버가 실제로 null을 준 경우를 검증).
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 30000, remainingMinor: null, currency: 'USD', period: 'month' },
      'compact',
    );
    expect(byTestId('generation-budget-remaining-compact')).toBeNull();
    expect(byTestId('generation-budget-failed')?.textContent).toBe('생성 비용 잔량을 확인하지 못했습니다');
  });

  it('⭐PO REQUIRED②(2026-09-05) — currency가 null이면(limitMinor는 있음) \'KRW\'로 추정하지 않고 failed와 동형으로 접는다', async () => {
    await renderIndicator(
      { status: 'ok', limitMinor: 100000, spentMinor: 30000, remainingMinor: 70000, currency: null, period: 'month' },
      'full',
    );
    expect(byTestId('generation-budget-remaining-full')).toBeNull();
    expect(byTestId('generation-budget-failed')?.textContent).toBe('잔량을 확인하지 못했습니다');
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

describe('⭐PO Design 재검①(2026-09-05, PR#3848) — en 로케일 KRW 표기는 실 en.json 값으로', () => {
  // 유나 정본: 자국(ko) 통화는 관용 표기("원"), 외국(en에서 본 KRW)은 국제 기호("₩").
  // 이 테스트가 실제 en.json 콘텐츠로 렌더한다 — stubT 단위 테스트로는 이 회귀를 못
  // 잡는다(그 stub이 정답을 그대로 베낀 것이라 실 메시지 파일 오타를 놓친다).
  it('KRW 카드 헤더가 en에서 "원"이 아니라 "₩"로 뜬다', async () => {
    await renderIndicatorEn(
      { status: 'ok', limitMinor: 100000, spentMinor: 0, remainingMinor: 100000, currency: 'KRW', period: 'month' },
      'full',
    );
    const text = byTestId('generation-budget-remaining-full')?.textContent ?? '';
    expect(text).toContain('₩100,000');
    expect(text).not.toContain('원');
  });

  it('USD는 en에서도 ko와 동형으로 "$"', async () => {
    await renderIndicatorEn(
      { status: 'ok', limitMinor: 50000, spentMinor: 0, remainingMinor: 50000, currency: 'USD', period: 'month' },
      'compact',
    );
    expect(byTestId('generation-budget-remaining-compact')?.textContent).toBe('$500.00 left');
  });
});
