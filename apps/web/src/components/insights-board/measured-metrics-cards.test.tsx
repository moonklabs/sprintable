// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { MeasuredMetricsCards } from './measured-metrics-cards';

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
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const MEASURED_AND_UNMEASURED = {
  utm_attribution_rate: { value: 0.3, numerator: 30, denominator: 100, reason_code: null },
  comment_miss_rate: { value: null, numerator: 0, denominator: 0, reason_code: 'NO_COMMENT_DATA' },
  follow_up_creation_rate: { value: 0, numerator: 0, denominator: 5, reason_code: null },
  reconciliation_coverage_rate: { value: 0.5, numerator: 1, denominator: 2, reason_code: null },
  // story #3620 CHANGES(2026-09-07) — 「불일치 수」는 count 형(분모/분자 0).
  reconciliation_mismatch_count: { value: 1, reason_code: null },
  computed_at: '2026-09-07T00:00:00Z',
};

function stubFetch(data: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data }) })));
}

// story #3618(BE+FE·실측) — 「0」과 「—」(미측정) 구분이 이 카드의 핵심 계약.
describe('MeasuredMetricsCards — 값·미측정·0 구분(story #3618)', () => {
  it('값이 있으면 퍼센트+분자/분모를 보여준다', async () => {
    stubFetch(MEASURED_AND_UNMEASURED);
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={7} />)); });
    await flush();

    const values = container.querySelectorAll('[data-testid="measured-metric-value"]');
    expect(values[0].textContent).toBe('30%');
    expect(container.textContent).toContain('30 / 100');
  });

  it('value가 null이면 「—」와 사유 한 줄을 보여준다(원문 수치 0으로 오인 방지)', async () => {
    stubFetch(MEASURED_AND_UNMEASURED);
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={7} />)); });
    await flush();

    const values = container.querySelectorAll('[data-testid="measured-metric-value"]');
    expect(values[1].textContent).toBe('—');
    expect(container.textContent).toContain('채널이 원본 댓글 수를 아직 안 줬습니다');
  });

  it('value가 0이면 「—」가 아니라 "0%"를 그대로 보여준다(측정은 됐고 실제로 0)', async () => {
    stubFetch(MEASURED_AND_UNMEASURED);
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={7} />)); });
    await flush();

    const values = container.querySelectorAll('[data-testid="measured-metric-value"]');
    expect(values[2].textContent).toBe('0%');
    expect(values[2].textContent).not.toBe('—');
  });
});

// story #3620(additive) — 4번째 카드 「채널 원본 지표와 evidence 대조」(coverage 본체
// +mismatch 보조 줄, 독립 사유 코드).
describe('MeasuredMetricsCards — 4번째 카드(reconciliation, story #3620)', () => {
  it('coverage 값이 있으면 퍼센트+분자/분모, mismatch 보조 줄은 「N건」을 함께 보여준다', async () => {
    stubFetch(MEASURED_AND_UNMEASURED);
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={7} />)); });
    await flush();

    const values = container.querySelectorAll('[data-testid="measured-metric-value"]');
    expect(values[3].textContent).toBe('50%');
    expect(container.textContent).toContain('1 / 2');
    const mismatchLine = container.querySelector('[data-testid="measured-metric-mismatch-line"]');
    expect(mismatchLine?.textContent).toBe('1건');
  });

  it('coverage·mismatch가 서로 다른 사유로 각자 「—」+사유 한 줄일 수 있다(coverage=NO_SNAPSHOTS·mismatch=NO_RECONCILIATIONS)', async () => {
    stubFetch({
      ...MEASURED_AND_UNMEASURED,
      reconciliation_coverage_rate: { value: null, numerator: 0, denominator: 0, reason_code: 'NO_SNAPSHOTS' },
      reconciliation_mismatch_count: { value: null, reason_code: 'NO_RECONCILIATIONS' },
    });
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={7} />)); });
    await flush();

    const values = container.querySelectorAll('[data-testid="measured-metric-value"]');
    expect(values[3].textContent).toBe('—');
    expect(container.textContent).toContain('집계할 발행 스냅샷이 없습니다');
    const mismatchLine = container.querySelector('[data-testid="measured-metric-mismatch-line"]');
    expect(mismatchLine?.textContent).toBe('—');
    expect(container.textContent).toContain('아직 대조한 발행이 없습니다');
  });

  it('mismatch가 0건이면(전부 일치) 「—」가 아니라 「0건」을 그대로 보여준다', async () => {
    stubFetch({
      ...MEASURED_AND_UNMEASURED,
      reconciliation_mismatch_count: { value: 0, reason_code: null },
    });
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={7} />)); });
    await flush();

    const mismatchLine = container.querySelector('[data-testid="measured-metric-mismatch-line"]');
    expect(mismatchLine?.textContent).toBe('0건');
  });

  // story #3620 CHANGES(페드루 PO 지시) — 세 판정(일치/불일치/미측정)이 같은 색·굵기면
  // 「불일치」가 안 눈에 띈다. 불일치만 font-medium text-foreground(destructive/빨강 아님).
  it('불일치 값은 font-medium text-foreground로 두드러지되 destructive(빨강)는 아니다', async () => {
    stubFetch(MEASURED_AND_UNMEASURED);
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={7} />)); });
    await flush();

    const mismatchLine = container.querySelector('[data-testid="measured-metric-mismatch-line"]');
    expect(mismatchLine?.className).toContain('font-medium');
    expect(mismatchLine?.className).toContain('text-foreground');
    expect(mismatchLine?.className).not.toContain('destructive');
  });
});

// story #3618 CHANGES 2(페드루 PO 채택, 유나 자리축) — 기간 조작은 화면에 하나(카드
// 자체 토글 삭제, 페이지 window prop을 따른다). 90일은 BE가 안 받는 값이라 조용히
// 30일로 떨어뜨리지 않고 「—」+사유로만 보여준다.
describe('MeasuredMetricsCards — windowDays prop이 페이지 기간을 그대로 따른다(CHANGES 2)', () => {
  it('windowDays가 바뀌면(7→30) 새 days로 다시 fetch한다(카드 자체 토글 없음)', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: true, json: async () => ({ data: MEASURED_AND_UNMEASURED }) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={7} />)); });
    await flush();

    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={30} />)); });
    await flush();

    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('days=7'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('days=30'))).toBe(true);
  });

  it('windowDays=90이면 BE를 아예 안 부르고 4장 다 「—」+WINDOW_UNSUPPORTED 사유를 보여준다', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: true, json: async () => ({ data: MEASURED_AND_UNMEASURED }) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={90} />)); });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    const values = container.querySelectorAll('[data-testid="measured-metric-value"]');
    expect(values).toHaveLength(4);
    for (const v of Array.from(values)) {
      expect(v.textContent).toBe('—');
    }
    expect(container.textContent).toContain('이 기간은 이 실측을 지원하지 않습니다');
    const mismatchLine = container.querySelector('[data-testid="measured-metric-mismatch-line"]');
    expect(mismatchLine?.textContent).toContain('—');
  });
});

// story #3620 CHANGES(카디르 발견, 라이브 실측 — 375px에서 20px 수치가 카드를 넘침) —
// grid-cols-3→4에 반응형 분기가 없었다. 좁은 화면 2열·md 이상 4열.
describe('MeasuredMetricsCards — 반응형 그리드(story #3620 CHANGES)', () => {
  it('카드 그리드가 좁은 화면 2열·md 이상 4열 클래스를 갖는다', async () => {
    stubFetch(MEASURED_AND_UNMEASURED);
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={7} />)); });
    await flush();

    const grid = container.querySelector('[data-testid="measured-metric-card"]')?.parentElement;
    expect(grid?.className).toContain('grid-cols-2');
    expect(grid?.className).toContain('lg:grid-cols-4');
  });
});

describe('MeasuredMetricsCards — 조회 실패', () => {
  it('조회 실패 시 에러 문구를 보여준다(에러 표면·크래시 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    await act(async () => { root.render(wrap(<MeasuredMetricsCards orgId="org-1" windowDays={7} />)); });
    await flush();

    expect(container.querySelector('[data-testid="measured-metrics-error"]')).not.toBeNull();
  });
});
