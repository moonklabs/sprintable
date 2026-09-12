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

async function render(snapshots: InsightSnapshot[], publicationId?: string | null) {
  await act(async () => {
    root.render(wrap(<InsightSnapshotBlock snapshots={snapshots} orgTimezone="UTC" locale="ko" publicationId={publicationId} />));
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

  it('skipped(story #3808 PR4) — 전용 문장(insightSnapshotSkipped)·중립 톤·값 시도 없음', async () => {
    const snap: InsightSnapshot = {
      normalized: { ...ALL_NULL }, captured_at: null, status: 'skipped', due_at: null, source: 'x_sandbox',
    };
    await render([snap]);
    const el = container.querySelector('[data-testid="insight-snapshot-skipped"]');
    expect(el?.textContent).toBe(koMessages.content.insightSnapshotSkipped);
    // 우리 상한 설정의 결과지 그 발행물의 실패가 아니다 — unsupported와 동형 중립 톤.
    expect(el?.className).not.toContain('text-destructive');
    expect(container.querySelector('[data-testid="insight-metric-value"]')).toBeNull();
  });

  it('failed — 전용 문장(insightSnapshotFailed)·destructive 톤·「다시 시도」 없음', async () => {
    // story #3499 후속(페드루 지시·유나 3426 실픽셀, 2026-09-10) — §17-10 공유 라벨
    // (insightStatusFailed, "실패" 한 낱말)은 insights-board-metric-cell.tsx의 표 셀
    // 명사구 전제와 이 블록의 형제 unsupported 문장 전제가 부딪혀 더는 못 같이 쓴다
    // (PO 채택 안 (b) — 소비처가 하나라는 전제가 깨져 전용 키 신설). attempt_count가
    // 이 화면엔 안 내려오므로(모르는 것을 단정하지 않는다) "다시 시도" 낱말이 없어야
    // 한다.
    const snap: InsightSnapshot = {
      normalized: { ...ALL_NULL }, captured_at: null, status: 'failed', due_at: null, source: 'threads',
    };
    await render([snap]);
    const el = container.querySelector('[data-testid="insight-snapshot-failure"]');
    expect(el?.textContent).toBe(koMessages.content.insightSnapshotFailed);
    expect(el?.textContent).not.toBe(koMessages.content.insightStatusFailed);
    expect(el?.textContent).not.toContain('다시 시도');
    expect(el?.className).toContain('text-destructive');
  });

  // story #3746(유나 v5, 2026-09-09) — dead_letter는 InsightSnapshot.status의 실
  // 값이 아니었다(걷는다). 되돌리면(다시 넣으면) 뮤테이션 표적 — 존재하지 않는
  // 값을 렌더 분기가 다시 받아주면 이 테스트가 실패해야 한다(union이 6값 그대로
  // 인지는 타입 자체가 컴파일 시점에 잡는다 — 여기는 런타임 값 부재를 pin).
  it('⭐뮤테이션 표적 — dead_letter는 더 이상 유효한 status가 아니다(6값 유니온 밖)', () => {
    const validStatuses = ['pending', 'in_progress', 'captured', 'unsupported', 'failed', 'superseded'];
    expect(validStatuses).not.toContain('dead_letter');
  });

  // story #3746(유나 v5) — in_progress는 실사용 값(수집기가 claim한 상태)인데
  // 기존 유니온이 빠뜨려 렌더가 안 죽는지 자체가 회귀 표적이었다(Partial<Record>+!
  // 였다면 t(undefined!) 크래시 자리) — pending과 같은 표시로 pin.
  it('⭐in_progress(captured_at 없음) — pending과 같은 자리(due 포함)로 렌더된다(크래시 0)', async () => {
    const snap: InsightSnapshot = {
      normalized: { ...ALL_NULL }, captured_at: null, status: 'in_progress', due_at: '2026-09-06T00:00:00Z', source: 'threads',
    };
    await render([snap]);
    const row = container.querySelector('[data-testid="insight-snapshot-pending"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('09-06');
  });

  // story #3746 — superseded는 BE가 기본 배제하므로 이 화면엔 사실상 안 오지만,
  // 온다면(방어적 엣지케이스) 크래시 없이 정직한 라벨로 떨어져야 한다(Record
  // 완전성 — 빠지면 빌드가 막는다).
  it('⭐superseded(방어적) — 크래시 없이 정직한 라벨로 렌더된다', async () => {
    const snap: InsightSnapshot = {
      normalized: { ...ALL_NULL }, captured_at: null, status: 'superseded', due_at: null, source: 'threads',
    };
    await render([snap]);
    expect(container.textContent).toContain(koMessages.content.insightStatusSuperseded);
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

// story #3617(유나 3600 AC2 기준선) — 마케팅 흐름의 마지막 구역 건너뛰기를 화면의
// 길로 없앤다. publicationId 유무로 링크 0/1을 가른다(발행 前에는 그릴 수 없다).
describe('InsightSnapshotBlock — 「성과 보드」 링크(story #3617)', () => {
  it('publicationId 없음(발행 前) — 링크가 안 보인다', async () => {
    await render([capturedSnapshot()], null);
    expect(container.querySelector('[data-testid="insight-view-in-board-link"]')).toBeNull();
  });

  it('publicationId 있음(발행 後) — 링크 1개, href에 publication id가 실린다', async () => {
    await render([capturedSnapshot()], 'pub-123');
    const links = container.querySelectorAll('[data-testid="insight-view-in-board-link"]');
    expect(links).toHaveLength(1);
    const href = links[0].getAttribute('href');
    expect(href).toBe('/organization/insights-board?highlight=pub-123');
  });

  // ⭐뮤테이션 표적 — publicationId 가드를 지우면(항상 렌더) 위 "없음" 테스트가 RED여야 한다.
  it('⭐뮤테이션 대조 — publicationId가 falsy 문자열이 아니라 실제 null/undefined일 때만 안 그린다', async () => {
    await render([capturedSnapshot()], undefined);
    expect(container.querySelector('[data-testid="insight-view-in-board-link"]')).toBeNull();
  });
});
