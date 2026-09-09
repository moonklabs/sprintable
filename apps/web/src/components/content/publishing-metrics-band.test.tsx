// @vitest-environment jsdom
//
// story #3484(BE 3475 계약, 정본 a0da40c9 §18 확定 2026-09-05) — 발행 계측 띠.
// BE가 아직 병합 前이라 stub fetch로 계약만 먼저 검증한다(라이브는 BE 착지 뒤).
//
// story #3746(2026-09-09) — 채널 목록에서 성과 보드 표 아래로 이주. 띠 자체 기간
// 토글은 걷고(화면의 windowParam을 prop으로 받는다), 연결 건강(만료·7일 내 만료)은
// ③(3743)이 맡아 이 띠에서 은퇴 — 그 두 축의 회귀 테스트도 함께 걷는다(기능 자체가
// 없어졌으므로, "없어졌다"를 pin하는 테스트로 대체).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PublishingMetricsBand } from './publishing-metrics-band';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

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
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const FULL_METRICS = {
  window: '7d', on_time_rate: 0.98 as number | null, on_time_numer: 49, on_time_denom: 50,
  duplicate_publications: 0, unapproved_adapter_calls: 0,
  recovery_seconds_p50: 240 as number | null, recovery_seconds_p95: 720 as number | null,
  connections_expired: 0, connections_expiring_7d: 0,
  computed_at: '2026-09-05T01:20:00Z' as string | null,
};

function stubFetch(byWindow: Record<string, typeof FULL_METRICS | { status: number }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const win = new URL(url, 'http://localhost').searchParams.get('window') ?? '7d';
    const entry = byWindow[win];
    if (!entry) return new Response(JSON.stringify({ data: null, error: { code: 'NOT_FOUND' } }), { status: 404 });
    if ('status' in entry) return new Response(JSON.stringify({ data: null, error: { code: 'FAILED' } }), { status: entry.status });
    return new Response(JSON.stringify({ data: entry }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

describe('PublishingMetricsBand(story #3484, §18)', () => {
  it('⭐성능 값이 채워지고, 사고 둘이 모두 0이면 사고 항목은 아무것도 안 뜬다(story #3735 B2 — 0을 굳이 요약하지 않는다)', async () => {
    stubFetch({ '7d': FULL_METRICS });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" window="7d" />)); });
    await flush();

    expect(container.querySelector('[data-testid="publishing-metrics-on-time-rate"]')?.textContent).toContain('98%');
    // story #3735(B1) — 복구 p50/p95(엔지니어 지표) 렌더 자체가 걷혔다.
    expect(container.querySelector('[data-testid="publishing-metrics-recovery"]')).toBeNull();
    // story #3735(B2) — 「중복·승인 없는 호출 0」 요약 줄도 걷혔다(0이면 아예 무언급).
    expect(container.querySelector('[data-testid="publishing-metrics-accident-zero"]')).toBeNull();
    expect(container.querySelector('[data-testid="publishing-metrics-duplicate"]')).toBeNull();
    expect(container.querySelector('[data-testid="publishing-metrics-unapproved"]')).toBeNull();
  });

  it('⭐사고 중 일부만 0이 아니면 그 항목만 개별로 뜬다(뭉침 없음)', async () => {
    stubFetch({
      '7d': { ...FULL_METRICS, duplicate_publications: 1 },
    });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" window="7d" />)); });
    await flush();

    expect(container.querySelector('[data-testid="publishing-metrics-accident-zero"]')).toBeNull();
    expect(container.querySelector('[data-testid="publishing-metrics-duplicate"]')?.textContent)
      .toBe(koMessages.content.publishingMetricsDuplicateNonzero.replace('{count}', '1'));
    expect(container.querySelector('[data-testid="publishing-metrics-unapproved"]')).toBeNull();
  });

  // story #3746 — 연결 건강(만료 연결·7일 내 만료) 은퇴 회귀 pin. BE 응답에 그
  // 필드가 0이 아니게 실려 와도(구 계약 잔존 값) 이 띠는 더 이상 그리지 않는다
  // (③이 그 신호를 맡는다) — 되돌리면(다시 그리게 하면) 이 테스트가 실패해야 한다.
  it('⭐뮤테이션 표적 — connections_expired/expiring이 0이 아니어도 연결 건강 항목을 그리지 않는다(③로 이관, 은퇴)', async () => {
    stubFetch({
      '7d': { ...FULL_METRICS, connections_expired: 2, connections_expiring_7d: 1 },
    });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" window="7d" />)); });
    await flush();

    expect(container.querySelector('[data-testid="publishing-metrics-connections-expired"]')).toBeNull();
    expect(container.querySelector('[data-testid="publishing-metrics-connections-expiring"]')).toBeNull();
    expect(container.querySelector('a[href="/organization/channels"]')).toBeNull();
  });

  it('⭐on_time_denom=0(분모 0) — on_time_rate=null이면 「—」+미측정 문구', async () => {
    stubFetch({ '7d': { ...FULL_METRICS, on_time_rate: null, on_time_numer: 0, on_time_denom: 0 } });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" window="7d" />)); });
    await flush();

    const el = container.querySelector('[data-testid="publishing-metrics-on-time-rate"]');
    expect(el?.textContent).toContain('—');
    expect(el?.textContent).toContain(koMessages.content.publishingMetricsUnmeasuredReason);
  });

  it('⭐조회 실패 — 「지표를 불러오지 못했습니다」(값 렌더 없음)', async () => {
    stubFetch({ '7d': { status: 500 } });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" window="7d" />)); });
    await flush();
    expect(container.querySelector('[data-testid="publishing-metrics-load-failed"]')?.textContent)
      .toBe(koMessages.content.publishingMetricsLoadFailed);
    expect(container.querySelector('[data-testid="publishing-metrics-on-time-rate"]')).toBeNull();
  });

  // story #3746 — 띠 자체 토글이 없어졌다(화면의 windowParam을 prop으로 받는다).
  // 그 화면 쪽 기간 컨트롤(7d/30d/90d)이 바뀌면 이 컴포넌트는 새 `window` prop으로
  // 재장착돼 그 값으로 다시 조회한다 — «자기 상태 없음»을 재장착으로 pin.
  it('⭐window prop이 바뀌면(화면의 기간 컨트롤을 그대로 따른다) 새 기간으로 재조회한다 — 90d 포함', async () => {
    stubFetch({
      '7d': FULL_METRICS,
      '90d': { ...FULL_METRICS, on_time_rate: 0.90, duplicate_publications: 3 },
    });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" window="7d" />)); });
    await flush();
    expect(container.querySelector('[data-testid="publishing-metrics-on-time-rate"]')?.textContent).toContain('98%');

    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" window="90d" />)); });
    await flush();

    expect(container.querySelector('[data-testid="publishing-metrics-on-time-rate"]')?.textContent).toContain('90%');
    expect(container.querySelector('[data-testid="publishing-metrics-duplicate"]')?.textContent)
      .toBe(koMessages.content.publishingMetricsDuplicateNonzero.replace('{count}', '3'));
  });

  it('⭐computed_at을 §11-2 정본 포맷으로 띠 끝에 보인다', async () => {
    stubFetch({ '7d': FULL_METRICS });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" window="7d" />)); });
    await flush();
    const el = container.querySelector('[data-testid="publishing-metrics-computed-at"]');
    expect(el?.textContent).toMatch(/09-05 \d{2}:\d{2}/);
  });

  it('computed_at이 없으면 그 자리를 안 그린다(Date.now()로 안 지어낸다)', async () => {
    stubFetch({ '7d': { ...FULL_METRICS, computed_at: null } });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" window="7d" />)); });
    await flush();
    expect(container.querySelector('[data-testid="publishing-metrics-computed-at"]')).toBeNull();
  });
});
