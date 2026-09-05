// @vitest-environment jsdom
//
// story #3484(BE 3475 계약, 정본 a0da40c9 §18 확定 2026-09-05) — 발행 계측 띠.
// BE가 아직 병합 前이라 stub fetch로 계약만 먼저 검증한다(라이브는 BE 착지 뒤).
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
  it('⭐다섯 값이 채워지면 성능 둘은 늘, 사고 둘은 모두 0이라 뭉쳐서 한 줄로 보인다', async () => {
    stubFetch({ '7d': FULL_METRICS });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" />)); });
    await flush();

    expect(container.querySelector('[data-testid="publishing-metrics-on-time-rate"]')?.textContent).toContain('98%');
    expect(container.querySelector('[data-testid="publishing-metrics-recovery"]')?.textContent).toContain('4분');
    expect(container.querySelector('[data-testid="publishing-metrics-recovery"]')?.textContent).toContain('12분');
    expect(container.querySelector('[data-testid="publishing-metrics-accident-zero"]')?.textContent)
      .toBe(koMessages.content.publishingMetricsAccidentZero);
    // 사고 둘 다 0이므로 개별 항목은 안 뜬다.
    expect(container.querySelector('[data-testid="publishing-metrics-duplicate"]')).toBeNull();
    expect(container.querySelector('[data-testid="publishing-metrics-unapproved"]')).toBeNull();
    // 행동 둘도 0이라 아예 안 뜬다(뭉침도 없음).
    expect(container.querySelector('[data-testid="publishing-metrics-connections-expired"]')).toBeNull();
    expect(container.querySelector('[data-testid="publishing-metrics-connections-expiring"]')).toBeNull();
  });

  it('⭐사고·행동 중 일부만 0이 아니면 그 항목만 개별로 뜬다(뭉침 없음)', async () => {
    stubFetch({
      '7d': { ...FULL_METRICS, duplicate_publications: 1, connections_expired: 2 },
    });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" />)); });
    await flush();

    expect(container.querySelector('[data-testid="publishing-metrics-accident-zero"]')).toBeNull();
    expect(container.querySelector('[data-testid="publishing-metrics-duplicate"]')?.textContent)
      .toBe(koMessages.content.publishingMetricsDuplicateNonzero.replace('{count}', '1'));
    expect(container.querySelector('[data-testid="publishing-metrics-unapproved"]')).toBeNull();
    const expiredLink = container.querySelector('[data-testid="publishing-metrics-connections-expired-link"]') as HTMLAnchorElement;
    expect(expiredLink.getAttribute('href')).toBe('/organization/channels');
    expect(expiredLink.textContent).toBe(koMessages.content.publishingMetricsConnectionsExpiredNonzero.replace('{count}', '2'));
    expect(container.querySelector('[data-testid="publishing-metrics-connections-expiring"]')).toBeNull();
  });

  it('⭐on_time_denom=0(분모 0) — on_time_rate=null이면 「—」+미측정 문구', async () => {
    stubFetch({ '7d': { ...FULL_METRICS, on_time_rate: null, on_time_numer: 0, on_time_denom: 0 } });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" />)); });
    await flush();

    const el = container.querySelector('[data-testid="publishing-metrics-on-time-rate"]');
    expect(el?.textContent).toContain('—');
    expect(el?.textContent).toContain(koMessages.content.publishingMetricsUnmeasuredReason);
  });

  it('⭐PO 보정(2026-09-05, PR#3833 리뷰) — recovery_seconds가 null이면 「—」만이 아니라 «이유»도 함께 선다(§18-2, 「고장인가」로 안 읽히게)', async () => {
    stubFetch({ '7d': { ...FULL_METRICS, recovery_seconds_p50: null, recovery_seconds_p95: null } });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" />)); });
    await flush();
    const el = container.querySelector('[data-testid="publishing-metrics-recovery"]');
    expect(el?.textContent).toContain('—');
    expect(el?.textContent).not.toContain('분');
    expect(el?.textContent).toContain(koMessages.content.publishingMetricsRecoveryNoFailures);
  });

  it('⭐조회 실패 — 「지표를 불러오지 못했습니다」(값 렌더 없음)', async () => {
    stubFetch({ '7d': { status: 500 } });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="publishing-metrics-load-failed"]')?.textContent)
      .toBe(koMessages.content.publishingMetricsLoadFailed);
    expect(container.querySelector('[data-testid="publishing-metrics-on-time-rate"]')).toBeNull();
  });

  it('⭐7d↔30d 토글 — 클릭하면 쿼리 window가 바뀌고 선택 상태(aria-pressed)가 갱신된다', async () => {
    stubFetch({
      '7d': FULL_METRICS,
      '30d': { ...FULL_METRICS, on_time_rate: 0.90, duplicate_publications: 3 },
    });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" />)); });
    await flush();

    const btn7d = container.querySelector('[data-testid="publishing-metrics-window-7d"]') as HTMLButtonElement;
    const btn30d = container.querySelector('[data-testid="publishing-metrics-window-30d"]') as HTMLButtonElement;
    expect(btn7d.getAttribute('aria-pressed')).toBe('true');
    expect(btn30d.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-testid="publishing-metrics-on-time-rate"]')?.textContent).toContain('98%');

    await act(async () => { btn30d.click(); });
    await flush();

    expect(btn30d.getAttribute('aria-pressed')).toBe('true');
    expect(btn7d.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-testid="publishing-metrics-on-time-rate"]')?.textContent).toContain('90%');
    expect(container.querySelector('[data-testid="publishing-metrics-duplicate"]')?.textContent)
      .toBe(koMessages.content.publishingMetricsDuplicateNonzero.replace('{count}', '3'));
  });

  it('토글 group에 role="group"+aria-label이 있다(스크린리더가 선택 상태를 안다)', async () => {
    stubFetch({ '7d': FULL_METRICS });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" />)); });
    await flush();
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe(koMessages.content.publishingMetricsWindowGroupLabel);
  });

  it('⭐computed_at을 §11-2 정본 포맷으로 띠 끝에 보인다', async () => {
    stubFetch({ '7d': FULL_METRICS });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" />)); });
    await flush();
    const el = container.querySelector('[data-testid="publishing-metrics-computed-at"]');
    expect(el?.textContent).toMatch(/09-05 \d{2}:\d{2}/);
  });

  it('computed_at이 없으면 그 자리를 안 그린다(Date.now()로 안 지어낸다)', async () => {
    stubFetch({ '7d': { ...FULL_METRICS, computed_at: null } });
    await act(async () => { root.render(wrap(<PublishingMetricsBand orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="publishing-metrics-computed-at"]')).toBeNull();
  });
});
