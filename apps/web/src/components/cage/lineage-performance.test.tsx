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
  ...overrides,
});

function stubLineageAndHooks(edges: unknown[], hookPerformanceByKey: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/v2/material-lineage/hook-performance')) {
      const key = new URL(url, 'http://x').searchParams.get('hook_key')!;
      const summary = hookPerformanceByKey[key];
      if (!summary) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => summary };
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

  it('hook_key가 하나도 없으면 훅 랭킹 섹션 자체를 안 그린다', async () => {
    stubLineageAndHooks([EDGE({ id: 'e1', hook_key: null })]);
    await act(async () => { root.render(wrap(<LineagePerformancePanel workItemId="story-1" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="lineage-performance-panel"]')!;
    expect(panel.textContent).not.toContain('훅 단위 성과');
  });
});
