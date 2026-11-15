// @vitest-environment jsdom
//
// 4913 D2 — 성과 보드 «안쪽 부품»(요약 4칸 · 광고 상한 · 비용 · 일별 광고비 · 행 상세 · 후속 조치 창 · 칸들 · 지표 띠)이
// 새 틀 안에서도 ds 부품·토큰만 쓴다: 옛 면(ui Card/Button/Skeleton/Alert · shadcn 색 토큰)이 섞이면 «후» 판정에서 걸린다.
// ① 소스 줄: 옛 import · 옛 토큰이 한 곳도 없다 ② 그림 줄: 실제로 ds 카드 · ds 뼈대가 선다.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ResultsSummaryCards } from './results-summary-cards';
import { AdsCapCard } from './ads-cap-card';
import { OrgCostSummaryCard, type OrgCostSummaryLoadState } from './org-cost-summary-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const INNER_FILES = [
  'insights-board/ads-cap-card.tsx',
  'insights-board/ads-spend-cell.tsx',
  'insights-board/follow-up-dialog.tsx',
  'insights-board/insights-board-comments-cell.tsx',
  'insights-board/insights-board-metric-cell.tsx',
  'insights-board/insights-board-row-detail.tsx',
  'insights-board/org-cost-summary-card.tsx',
  'insights-board/paid-spend-daily-series-card.tsx',
  'insights-board/reconcile-result-line.tsx',
  'insights-board/results-summary-cards.tsx',
  'content/publishing-metrics-band.tsx',
];

// shadcn 색 토큰 · 옛 글자 크기 · 옛 모서리 · 손으로 만든 뼈대.
const OLD_TOKEN = /(?<![\w-])(?:(?:text|bg|border|ring|fill|stroke)-(?:muted-foreground|foreground|muted|border|input|destructive|primary|card|accent|popover|background|warning-strong)(?:\/\d+)?|text-(?:xs|sm|lg|micro)|rounded(?:-(?:t|b|l|r|tl|tr|bl|br|s|e))?-(?:md|lg|sm|xl)|animate-pulse)(?![\w-])/;
const OLD_IMPORT = /from ['"]@\/components\/ui\//;

describe('4913 D2 — 성과 보드 안쪽 부품: 소스에 옛 면이 없다', () => {
  for (const rel of INNER_FILES) {
    it(`${rel} — ui import 0 · 옛 토큰 0`, () => {
      const src = readFileSync(resolve(HERE, '..', rel), 'utf8')
        // 주석(설명)에 남은 옛 낱말은 면이 아니다 — 코드 줄만 본다.
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(src.match(OLD_IMPORT), `${rel}: 옛 ui import`).toBeNull();
      const hit = src.match(OLD_TOKEN);
      expect(hit?.[0] ?? null, `${rel}: 옛 토큰`).toBeNull();
    });
  }
});

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

const LOADING: OrgCostSummaryLoadState = { status: 'loading' };
const FAILED: OrgCostSummaryLoadState = { status: 'failed' };

describe('4913 D2 — 안쪽 부품이 ds 카드 · ds 뼈대로 선다', () => {
  it('⭐요약 4칸은 ds 카드 넷이고, 불러오는 동안 칸 안 뼈대는 ds 뼈대다', async () => {
    await act(async () => {
      root.render(wrap(
        <ResultsSummaryCards
          publishedInWindow={null} viewsInWindow={null} ga4ConnectionStatus="not_connected"
          boardLoading costSummaryState={LOADING} boardLoadFailed={false} onRetryCostSummary={() => {}}
        />,
      ));
    });
    const cards = container.querySelectorAll('[data-testid="results-summary-cards"] > [data-slot="ds-card"]');
    expect(cards).toHaveLength(4);
    for (const id of ['results-summary-published-loading', 'results-summary-organic-views-loading', 'results-summary-ads-spend-loading', 'results-summary-ads-remaining-loading']) {
      expect(container.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-slot'), id).toBe('ds-skeleton');
    }
  });

  it('⭐광고 상한 카드는 ds 카드이고, 펼침 단추는 ds 단추(aria-expanded)다', async () => {
    await act(async () => {
      root.render(wrap(<AdsCapCard orgId="org-1" costSummaryState={FAILED} />));
    });
    expect(container.querySelector('[data-testid="ads-cap-card"]')?.getAttribute('data-slot')).toBe('ds-card');
    const toggle = container.querySelector('[data-testid="ads-cap-card-toggle"]') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('data-slot')).toBe('ds-button');
    // 접는 머리 단추는 «조용한(quiet)» 모양 — 테두리 없이 카드 머리처럼 보인다(주 행동 색이 아님).
    expect(toggle.className).toContain('border-transparent');
    expect(toggle.className).not.toContain('bg-ds-action');
  });

  it('⭐비용 카드는 불러오는 중 · 실패 둘 다 ds 카드이고 불러오는 칸은 ds 뼈대다', async () => {
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" preloadedState={LOADING} />)); });
    const loading = container.querySelector('[data-testid="org-cost-summary-card-loading"]')!;
    expect(loading.getAttribute('data-slot')).toBe('ds-card');
    expect(loading.querySelector('[data-slot="ds-skeleton"]')).not.toBeNull();
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" preloadedState={FAILED} />)); });
    expect(container.querySelector('[data-testid="org-cost-summary-card-failed"]')?.getAttribute('data-slot')).toBe('ds-card');
  });
});
