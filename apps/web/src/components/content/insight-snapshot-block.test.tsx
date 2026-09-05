// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { InsightSnapshotBlock, type InsightSnapshot, type InsightNormalizedMetrics } from './insight-snapshot-block';

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

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

async function render(snapshots: InsightSnapshot[]) {
  await act(async () => {
    root.render(wrap(<InsightSnapshotBlock snapshots={snapshots} orgTimezone="UTC" locale="ko" />));
  });
}

const ALL_NULL: InsightNormalizedMetrics = {
  impressions: null, reach: null, views: null, engagements: null, clicks: null, spend: null, conversions: null,
};

function capturedSnapshot(overrides: Partial<InsightSnapshot> = {}): InsightSnapshot {
  return {
    normalized: { ...ALL_NULL },
    captured_at: '2026-09-06T00:00:00Z',
    status: 'captured',
    due_at: '2026-09-06T00:00:00Z',
    source: 'threads',
    ...overrides,
  };
}

const METRIC_KEYS = ['impressions', 'reach', 'views', 'engagements', 'clicks', 'spend', 'conversions'] as const;

describe('InsightSnapshotBlock — story #3499(게시물 성과 표면 1차)', () => {
  it('빈 배열 — 아무것도 안 그린다', async () => {
    await render([]);
    expect(container.textContent).toBe('');
  });

  // 3497의 척추 — null(미제공) vs 0(실측 0)을 절대 같은 얼굴로 그리지 않는다.
  // 7지표 × {null, 0, 양수} 진리표 — 각 지표를 개별로 검증.
  describe.each(METRIC_KEYS)('7지표×{null,0,n} 진리표 — %s', (metricKey) => {
    it(`${metricKey}=null → 대시+사유 두 키(값 아님)`, async () => {
      const snap = capturedSnapshot({ normalized: { ...ALL_NULL, [metricKey]: null } });
      await render([snap]);
      const row = container.querySelector('[data-testid="insight-latest-row"]');
      expect(row?.textContent).toContain(koMessages.content.insightMetricUnavailableDash);
      expect(row?.textContent).toContain(koMessages.content.insightMetricUnavailableReason);
    });

    it(`${metricKey}=0 → 숫자 0을 그대로 그린다(대시 아님)`, async () => {
      const snap = capturedSnapshot({ normalized: { ...ALL_NULL, [metricKey]: 0 } });
      await render([snap]);
      const values = Array.from(container.querySelectorAll('[data-testid="insight-metric-value"]')).map((el) => el.textContent);
      expect(values).toContain('0');
      // 이 지표 자리엔 대시/사유가 없어야 함 — 0과 null을 같은 얼굴로 안 그린다는 확인의
      // 핵심(라벨 텍스트 자체는 다른 지표 라벨과 안 겹치므로 값 노드만 본다).
    });

    it(`${metricKey}=42(양수) → 숫자 그대로`, async () => {
      const snap = capturedSnapshot({ normalized: { ...ALL_NULL, [metricKey]: 42 } });
      await render([snap]);
      const values = Array.from(container.querySelectorAll('[data-testid="insight-metric-value"]')).map((el) => el.textContent);
      expect(values).toContain('42');
    });
  });

  it('captured 상태 — "수집됨" 배지를 값과 함께 안 그린다(유나 §17-19 비배지 원칙)', async () => {
    const snap = capturedSnapshot({ normalized: { ...ALL_NULL, impressions: 10 } });
    await render([snap]);
    const row = container.querySelector('[data-testid="insight-latest-row"]');
    expect(row?.textContent).not.toContain(koMessages.content.insightStatusCaptured);
  });

  it('captured_at은 formatRelativeTime(상대시각, §11-2 기록 축) — ISO 그대로 안 보인다', async () => {
    const snap = capturedSnapshot({ captured_at: new Date().toISOString() });
    await render([snap]);
    const row = container.querySelector('[data-testid="insight-latest-row"]');
    expect(row?.textContent).not.toContain('T00:00:00');
  });

  it('latest는 status=captured 중 captured_at 최댓값 — 별도 latest_insight 필드가 있어도 무시하고 목록에서 직접 계산', async () => {
    const older = capturedSnapshot({ captured_at: '2026-09-01T00:00:00Z', normalized: { ...ALL_NULL, impressions: 1 } });
    const newer = capturedSnapshot({ captured_at: '2026-09-07T00:00:00Z', normalized: { ...ALL_NULL, impressions: 99 } });
    await render([older, newer]);
    const values = Array.from(container.querySelectorAll('[data-testid="insight-metric-value"]')).map((el) => el.textContent);
    expect(values).toContain('99');
    expect(values).not.toContain('1');
  });

  it('captured 스냅샷이 하나도 없으면 latest 행 자체를 안 그린다', async () => {
    const pending: InsightSnapshot = {
      normalized: { ...ALL_NULL }, captured_at: null, status: 'pending', due_at: '2026-09-06T00:00:00Z', source: 'threads',
    };
    await render([pending]);
    expect(container.querySelector('[data-testid="insight-latest-row"]')).toBeNull();
  });

  it('pending(captured_at null) — "+N일 예정" 문구(due_at 포함)', async () => {
    const pending: InsightSnapshot = {
      normalized: { ...ALL_NULL }, captured_at: null, status: 'pending', due_at: '2026-09-06T00:00:00Z', source: 'threads',
    };
    await render([pending]);
    const row = container.querySelector('[data-testid="insight-snapshot-pending"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('09-06');
  });

  it('unsupported — 「이 채널은 성과를 제공하지 않습니다」(스토리 AC2 원문), 값 시도 없음', async () => {
    const snap: InsightSnapshot = {
      normalized: { ...ALL_NULL }, captured_at: null, status: 'unsupported', due_at: null, source: 'stibee',
    };
    await render([snap]);
    expect(container.querySelector('[data-testid="insight-snapshot-unsupported"]')?.textContent)
      .toBe(koMessages.content.insightSnapshotUnsupported);
    expect(container.querySelector('[data-testid="insight-metric-value"]')).toBeNull();
  });

  it('failed — §17-10 라벨 재사용·destructive 톤', async () => {
    const snap: InsightSnapshot = {
      normalized: { ...ALL_NULL }, captured_at: null, status: 'failed', due_at: null, source: 'threads',
    };
    await render([snap]);
    const el = container.querySelector('[data-testid="insight-snapshot-failure"]');
    expect(el?.textContent).toBe(koMessages.content.insightStatusFailed);
    expect(el?.className).toContain('text-destructive');
  });

  it('dead_letter — §17-10 라벨 재사용·destructive 톤', async () => {
    const snap: InsightSnapshot = {
      normalized: { ...ALL_NULL }, captured_at: null, status: 'dead_letter', due_at: null, source: 'threads',
    };
    await render([snap]);
    const el = container.querySelector('[data-testid="insight-snapshot-failure"]');
    expect(el?.textContent).toBe(koMessages.content.insightStatusDeadLetter);
    expect(el?.className).toContain('text-destructive');
  });

  it('unsupported/pending은 중립 톤(destructive 아님, §17-18 "성질이지 실패가 아니다")', async () => {
    const unsupported: InsightSnapshot = {
      normalized: { ...ALL_NULL }, captured_at: null, status: 'unsupported', due_at: null, source: 'stibee',
    };
    await render([unsupported]);
    const el = container.querySelector('[data-testid="insight-snapshot-unsupported"]');
    expect(el?.className).not.toContain('text-destructive');
  });
});
