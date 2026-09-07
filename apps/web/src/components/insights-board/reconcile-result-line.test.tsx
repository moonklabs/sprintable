// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ReconcileResultLine } from './reconcile-result-line';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

// story #3620 AC3 — 결과 한 줄: 지표별 「지표명 판정」을 · 로 이어붙인다. 순서는
// insight-snapshot-block.tsx의 METRIC_KEYS와 동형(impressions·reach·views·
// engagements·clicks·spend·conversions), verdicts에 없는 키는 건너뛴다.
describe('ReconcileResultLine(story #3620)', () => {
  it('지표별 판정 3값(일치/불일치/미측정)을 순서대로 이어붙인다', async () => {
    await act(async () => {
      root.render(wrap(<ReconcileResultLine verdicts={{ views: 'mismatch', engagements: 'match', impressions: 'unmeasured' }} />));
    });
    const text = container.querySelector('[data-testid="reconcile-result-line"]')?.textContent;
    expect(text).toBe(
      `${koMessages.content.insightMetricImpressions} ${koMessages.insightsBoard.reconcileVerdictUnmeasured} · `
      + `${koMessages.content.insightMetricViews} ${koMessages.insightsBoard.reconcileVerdictMismatch} · `
      + `${koMessages.content.insightMetricEngagements} ${koMessages.insightsBoard.reconcileVerdictMatch}`,
    );
  });

  it('verdicts에 없는 키는 줄에서 빠진다', async () => {
    await act(async () => {
      root.render(wrap(<ReconcileResultLine verdicts={{ spend: 'match' }} />));
    });
    const text = container.querySelector('[data-testid="reconcile-result-line"]')?.textContent;
    expect(text).toBe(`${koMessages.content.insightMetricSpend} ${koMessages.insightsBoard.reconcileVerdictMatch}`);
  });

  // story #3620 CHANGES(카디르 발견, #3971 클래스) — 서버가 모르는 판정값을 원문 그대로
  // 화면에 흘리면 안 된다. 알려진 3값 밖은 「미측정」으로 접는다.
  it('알려지지 않은 판정값은 raw 그대로가 아니라 「미측정」으로 보인다(원문 유출 금지)', async () => {
    await act(async () => {
      root.render(wrap(<ReconcileResultLine verdicts={{ spend: 'some-future-verdict-value' }} />));
    });
    const text = container.querySelector('[data-testid="reconcile-result-line"]')?.textContent;
    expect(text).toBe(`${koMessages.content.insightMetricSpend} ${koMessages.insightsBoard.reconcileVerdictUnmeasured}`);
    expect(text).not.toContain('some-future-verdict-value');
  });

  // story #3620 CHANGES(페드루 PO 지시, 유나 PASS 후속) — 결과 줄에서 세 판정이 한
  // 색·굵기라 「불일치」가 안 두드러졌다. 불일치 판정 조각만 font-medium text-foreground.
  it('불일치 판정만 font-medium text-foreground로 두드러진다(destructive 아님)', async () => {
    await act(async () => {
      root.render(wrap(<ReconcileResultLine verdicts={{ views: 'mismatch', engagements: 'match' }} />));
    });
    const line = container.querySelector('[data-testid="reconcile-result-line"]');
    const spans = [...(line?.querySelectorAll('span') ?? [])];
    const mismatchSpan = spans.find((s) => s.textContent === koMessages.insightsBoard.reconcileVerdictMismatch);
    const matchSpan = spans.find((s) => s.textContent === koMessages.insightsBoard.reconcileVerdictMatch);
    expect(mismatchSpan?.className).toContain('font-medium');
    expect(mismatchSpan?.className).toContain('text-foreground');
    expect(mismatchSpan?.className).not.toContain('destructive');
    expect(matchSpan?.className ?? '').not.toContain('font-medium');
  });
});
