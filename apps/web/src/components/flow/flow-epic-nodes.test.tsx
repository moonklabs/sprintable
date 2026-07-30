// @vitest-environment jsdom
//
// story #2224 후속(2026-07-30) — 오르테가군 확定: "화면이 보던 dependencies(0행)와 디디군이
// 채운 reference_semantic_candidates(1321건)는 다른 표"라 벌크 엔드포인트를 추가로 불러
// 병합해야 실 후보가 화면에 온다. 이 테스트는 세 fetch(epic-flow-nodes/dependencies-graph/
// reference-candidates)가 실제로 나가고, 두 간선 출처가 하나로 합쳐져 렌더까지 이어지는
// 것을 왕복 확認한다 — mock fetch로 로컬에서만(DB 무관).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { FlowEpicNodes } from './flow-epic-nodes';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const NOW_ITEM = { id: 'n1', story_number: 1, title: 'Now Story', status: 'in-progress', assignee_id: null, updated_at: '2026-07-30T00:00:00Z' };
const UPCOMING_ITEM = { id: 'u1', story_number: 2, title: 'Upcoming Story', status: 'backlog', assignee_id: null, updated_at: '2026-07-30T00:00:00Z' };

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
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

describe('FlowEpicNodes — merges dependencies-graph edges with reference-candidate edges', () => {
  it('calls all three endpoints (epic-flow-nodes / dependencies-graph / reference-candidates) and renders a line sourced from candidate data', async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calledUrls.push(url);
      if (url.includes('/api/analytics/epic-flow-nodes')) {
        return jsonResponse({
          data: {
            epic_id: 'e1',
            now: { total: 1, items: [NOW_ITEM] },
            upcoming: { total: 1, shown: 1, items: [UPCOMING_ITEM] },
            past: { total: 0 },
            blocked_count: 0,
            last_changed_at: null,
          },
        });
      }
      if (url.includes('/api/dependencies/graph')) {
        return jsonResponse({ item_type: 'story', nodes: [], edges: [] }); // 계획형 — 오늘도 0행
      }
      if (url.includes('/api/goals/e1/reference-candidates')) {
        // 벌크 엔드포인트 — 디디군 백필 재료(raw array, 래핑 없음)
        return jsonResponse([
          { id: 'c1', source_id: 'n1', source_field: 'description', target_type: 'story', target_id: 'u1', relation_kind: 'spawned', matched_keyword: null, snippet: 's', status: 'estimated', declared_by: null, declared_at: null, created_at: '2026-07-30T00:00:00Z' },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(wrap(<FlowEpicNodes projectId="p1" epicId="e1" epicTitle="Epic 1" onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u.includes('/api/analytics/epic-flow-nodes'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('/api/dependencies/graph'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('/api/goals/e1/reference-candidates'))).toBe(true);

    const line = container.querySelector('line[data-edge-kind="spawn"]');
    expect(line).not.toBeNull();
    expect(line?.getAttribute('data-edge-confirmed')).toBe('false'); // status=estimated → 제안
  });

  it('still renders (no edges, no crash) when the reference-candidates fetch fails — partial failure does not kill the whole view', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/analytics/epic-flow-nodes')) {
        return jsonResponse({
          data: {
            epic_id: 'e1', now: { total: 1, items: [NOW_ITEM] }, upcoming: { total: 0, shown: 0, items: [] },
            past: { total: 0 }, blocked_count: 0, last_changed_at: null,
          },
        });
      }
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      if (url.includes('/api/goals/e1/reference-candidates')) return { ok: false, json: async () => null } as Response;
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(wrap(<FlowEpicNodes projectId="p1" epicId="e1" epicTitle="Epic 1" onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector('line[data-edge-kind]')).toBeNull();
    expect(container.textContent).not.toContain('불러오지 못했습니다');
  });
});
