// @vitest-environment jsdom
//
// story #4063(E-RECIPE-1 ④, 유나 성과 시안 v2·artifact 18fc7937 위) — production-workbench-
// evidence.test.tsx와 동일 하네스.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { LineagePerformancePanel } from './lineage-performance';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

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

async function flush(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

const EDGE = (overrides: Record<string, unknown>) => ({
  id: 'e1', source_evidence_id: 'ev-master-1', derived_kind: 'channel_post_draft', derived_id: 'draft-1',
  relation_kind: 'platform_cut', variant_axis: 'reels', hook_key: null, work_item_id: 'story-1',
  master_title: null, channel: null,
  ...overrides,
});

function stubLineageAndHooks(
  edges: unknown[],
  hookPerformanceByKey: Record<string, unknown> = {},
  materialPerformanceByDerivedId: Record<string, unknown[]> = {},
) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/v2/material-lineage/hook-performance')) {
      const key = new URL(url, 'http://x').searchParams.get('hook_key')!;
      const summary = hookPerformanceByKey[key];
      if (!summary) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => summary };
    }
    if (url.startsWith('/api/v2/material-lineage/material-performance')) {
      const derivedId = new URL(url, 'http://x').searchParams.get('derived_id')!;
      return { ok: true, json: async () => (materialPerformanceByDerivedId[derivedId] ?? []) };
    }
    return { ok: true, json: async () => edges };
  }));
}

describe('LineagePerformancePanel', () => {
  it('계보 edge가 0건이면 패널 자체를 안 그린다(없으면 비운다)', async () => {
    stubLineageAndHooks([]);
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="lineage-performance-panel"]')).toBeNull();
  });

  it('실패 시에도 조용히 비운다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="lineage-performance-panel"]')).toBeNull();
  });

  it('마스터+변주를 flat 트리로 그린다(aspect_adapt도 형제) — relation_kind별 그룹', async () => {
    stubLineageAndHooks([
      EDGE({ id: 'e1', relation_kind: 'platform_cut', variant_axis: 'reels' }),
      EDGE({ id: 'e2', relation_kind: 'aspect_adapt', variant_axis: '1:1' }),
    ]);
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="lineage-performance-panel"]');
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain('reels');
    expect(panel!.textContent).toContain('1:1');
    expect(panel!.textContent).toContain('플랫폼컷');
    expect(panel!.textContent).toContain('비율 변형');
  });

  it('hook_key가 있는 edge만 훅 랭킹 섹션을 채우고, 1위 대비 막대·집계 대기를 정직하게 낸다', async () => {
    stubLineageAndHooks(
      [
        EDGE({ id: 'e1', hook_key: 'hook_a' }),
        EDGE({ id: 'e2', hook_key: 'hook_b', relation_kind: 'hook_variant' }),
      ],
      {
        hook_a: { hook_key: 'hook_a', variant_count: 2, snapshot_count: 1, totals: { views: 100 } },
        hook_b: { hook_key: 'hook_b', variant_count: 1, snapshot_count: 0, totals: { views: null } },
      },
    );
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="lineage-performance-panel"]')!;
    expect(panel.textContent).toContain('hook_a');
    expect(panel.textContent).toContain('hook_b');
    expect(panel.textContent).toContain('100');
    expect(panel.textContent).toContain('집계 대기'); // hook_b totals.views===null
  });

  // story #4063 design 재QA(유나, 2026-09-19) — 트리 변주 행의 훅 배지가 내부 식별자
  // hook_key 원문을 그대로 "훅 {key}"로 이어붙여 보여줬다(사용자 스코프 문구에 내부어 노출).
  // 배지는 plain "훅"만 — 훅 랭킹 섹션(카드 라벨, 원문 키를 그대로 보여주는 게 그 카드의
  // 의도된 계약)은 이 fix 범위 밖이라 그대로 유지되는지도 함께 pin.
  it('트리 변주 행의 훅 배지는 "훅 {원문키}"로 이어붙이지 않고 plain "훅"만 보여준다(design 재QA pin)', async () => {
    stubLineageAndHooks(
      [EDGE({ id: 'e1', hook_key: 'hook_internal_slug_xyz', relation_kind: 'hook_variant' })],
      { hook_internal_slug_xyz: { hook_key: 'hook_internal_slug_xyz', variant_count: 1, snapshot_count: 0, totals: { views: null } } },
    );
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="lineage-performance-panel"]')!;
    // 수정 前 버그 형태(내부 키가 그대로 이어붙어 뜨는 문구)가 더는 없다.
    expect(panel.textContent).not.toContain('훅 hook_internal_slug_xyz');
    // 배지 자체는 정확히 "훅 연결" 텍스트만 담은 요소로 존재한다(트리 행 안, 내부 키 미노출).
    const exactHookBadge = [...panel.querySelectorAll('span, div')].find((el) => el.textContent?.trim() === '훅 연결');
    expect(exactHookBadge).toBeDefined();
    // 훅 랭킹 섹션(별도 카드, 원문 키를 라벨로 보여주는 게 그 카드의 의도된 계약)은 안 건드렸다.
    expect(panel.textContent).toContain('hook_internal_slug_xyz');
  });

  it('hook_key가 하나도 없으면 훅 랭킹 섹션 자체를 안 그린다', async () => {
    stubLineageAndHooks([EDGE({ id: 'e1', hook_key: null })]);
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="lineage-performance-panel"]')!;
    expect(panel.textContent).not.toContain('훅 단위 성과');
  });

  it('master_title·channel이 있으면 uuid 대신 읽을 이름을 낸다(#4063 후속 갭2)', async () => {
    stubLineageAndHooks([
      EDGE({ id: 'e1', derived_kind: 'channel_publication', derived_id: 'pub-1', master_title: '가을 신상 15초 컷', channel: 'instagram' }),
    ]);
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="lineage-performance-panel"]')!;
    expect(panel.textContent).toContain('가을 신상 15초 컷');
    expect(panel.textContent).toContain('Instagram');
    expect(panel.textContent).not.toContain('ev-master'); // shortId 폴백이 안 쓰였다
  });

  it('master_title·channel이 null이면 여전히 {kind} #{짧은id} 폴백을 쓴다(지어내지 않음)', async () => {
    stubLineageAndHooks([EDGE({ id: 'e1', master_title: null, channel: null })]);
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="lineage-performance-panel"]')!;
    expect(panel.textContent).toContain('channel_post_draft');
  });

  it('발행된(channel_publication) 변주는 성과 막대·1위 대비 값을 낸다, 미발행(draft)은 "미발행"만', async () => {
    stubLineageAndHooks(
      [
        EDGE({ id: 'e1', derived_kind: 'channel_publication', derived_id: 'pub-1' }),
        EDGE({ id: 'e2', derived_kind: 'channel_publication', derived_id: 'pub-2' }),
        EDGE({ id: 'e3', derived_kind: 'channel_post_draft', derived_id: 'draft-1' }),
      ],
      {},
      {
        'pub-1': [{ id: 's1', channel: 'instagram', due_at: '2026-09-01T00:00:00Z', captured_at: '2026-09-01T00:00:00Z', status: 'captured', normalized: { views: 100 }, source: 'organic', error_code: null, offset_label: 'd1' }],
        'pub-2': [{ id: 's2', channel: 'instagram', due_at: '2026-09-07T00:00:00Z', captured_at: '2026-09-07T00:00:00Z', status: 'captured', normalized: { views: 400 }, source: 'organic', error_code: null, offset_label: 'd7' }],
      },
    );
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="lineage-performance-panel"]')!;
    expect(panel.textContent).toContain('100');
    expect(panel.textContent).toContain('400');
    expect(panel.textContent).toContain('미발행');
  });

  it('발행됐지만 아직 captured snapshot이 없으면 "집계 대기"(0으로 위장 안 함)', async () => {
    stubLineageAndHooks(
      [EDGE({ id: 'e1', derived_kind: 'channel_publication', derived_id: 'pub-1' })],
      {},
      { 'pub-1': [] },
    );
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="lineage-performance-panel"]')!;
    expect(panel.textContent).toContain('집계 대기');
  });
});
