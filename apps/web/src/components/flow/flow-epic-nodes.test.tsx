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
      root.render(wrap(<FlowEpicNodes projectId="p1" epicId="e1" epicTitle="Epic 1" onSelectStory={() => {}} memberMap={{}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u.includes('/api/analytics/epic-flow-nodes'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('/api/dependencies/graph'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('/api/goals/e1/reference-candidates'))).toBe(true);

    const line = container.querySelector('line[data-edge-kind="spawn"]');
    expect(line).not.toBeNull();
    expect(line?.getAttribute('data-edge-confirmed')).toBe('false'); // status=estimated → 제안
  });

  // 자가발견 결함(2026-07-30, PR#2709 배포 후 재검토 중) — "양끝 다 now/upcoming에 있는
  // 것만" 미리 걸러내던 필터가 있으면, 과거(done) 스토리에 닿은 간선은 deriveFlowMapLane의
  // 묶음-해소 로직(PR#2709)에 도달하기도 전에 사라진다. 그 필터를 없앤 것을 여기서 고정한다
  // — target_id가 now/upcoming 어디에도 없는(=과거로 해석되는) 후보가 실제로 묶음-해소된
  // <line>까지 그려지는 것을 왕복 확認.
  it('renders a bundle-resolved line for a candidate edge whose target is NOT in now/upcoming (a past/done story) when pastTotal > 0 — regression for the premature pre-filter bug', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/analytics/epic-flow-nodes')) {
        return jsonResponse({
          data: {
            epic_id: 'e1', now: { total: 1, items: [NOW_ITEM] }, upcoming: { total: 0, shown: 0, items: [] },
            past: { total: 5 }, blocked_count: 0, last_changed_at: null,
          },
        });
      }
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      if (url.includes('/api/goals/e1/reference-candidates')) {
        // target_id='past-story'는 now/upcoming 그 어디에도 없다 — 과거로 해석돼야 한다.
        return jsonResponse([
          { id: 'c1', source_id: 'past-story', source_field: 'description', target_type: 'story', target_id: 'n1', relation_kind: 'spawned', matched_keyword: null, snippet: 's', status: 'declared', declared_by: null, declared_at: null, created_at: '2026-07-30T00:00:00Z' },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(wrap(<FlowEpicNodes projectId="p1" epicId="e1" epicTitle="Epic 1" onSelectStory={() => {}} memberMap={{}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const line = container.querySelector('line[data-edge-kind="spawn"]');
    expect(line).not.toBeNull(); // 필터가 남아 있었다면 여기서 null이었을 것(재현 확認).
    expect(line?.getAttribute('data-edge-confirmed')).toBe('true');
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
      root.render(wrap(<FlowEpicNodes projectId="p1" epicId="e1" epicTitle="Epic 1" onSelectStory={() => {}} memberMap={{}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector('line[data-edge-kind]')).toBeNull();
    expect(container.textContent).not.toContain('불러오지 못했습니다');
  });
});

// 유나양 규격(아티팩트 a125909a, "누르면 펼쳐지는 것이 곧 줌인") — 묶음 카드 클릭이 실제로
// `/api/stories?epic_id=&status=done`(project_id 없이)을 부르고, 그 결과로 과거 스토리가
// 개별 카드로 서고 간선이 묶음이 아닌 개별 좌표로 다시 그려지는 것을 왕복 확認한다.
describe('FlowEpicNodes — clicking the past-bundle card expands it (실제 fetch → 개별 노드)', () => {
  it('fetches done stories WITHOUT project_id when the bundle card is clicked, and re-resolves edges to individual past nodes', async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calledUrls.push(url);
      if (url.includes('/api/analytics/epic-flow-nodes')) {
        return jsonResponse({
          data: {
            epic_id: 'e1', now: { total: 1, items: [NOW_ITEM] }, upcoming: { total: 0, shown: 0, items: [] },
            past: { total: 1 }, blocked_count: 0, last_changed_at: null,
          },
        });
      }
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      if (url.includes('/api/goals/e1/reference-candidates')) {
        return jsonResponse([
          { id: 'c1', source_id: 'past-1', source_field: 'description', target_type: 'story', target_id: 'n1', relation_kind: 'spawned', matched_keyword: null, snippet: 's', status: 'declared', declared_by: null, declared_at: null, created_at: '2026-07-30T00:00:00Z' },
        ]);
      }
      if (url.startsWith('/api/stories?')) {
        expect(url).not.toContain('project_id'); // board 분기(7일/10건 캡) 함정 회피 확認.
        expect(url).toContain('epic_id=e1');
        expect(url).toContain('status=done');
        return jsonResponse({
          data: [{ id: 'past-1', story_number: 99, title: 'Past Story', status: 'done' }],
          meta: { hasMore: false, nextCursor: null },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(wrap(<FlowEpicNodes projectId="p1" epicId="e1" epicTitle="Epic 1" onSelectStory={() => {}} memberMap={{}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    // 접힌 상태 — 묶음 해소된 선(from=bundle) 하나.
    expect(container.querySelector('line[data-edge-kind="spawn"]')).not.toBeNull();
    expect(container.textContent).toContain('완료 1');

    const bundleButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('완료 1'));
    expect(bundleButton).not.toBeUndefined();
    await act(async () => {
      bundleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u.startsWith('/api/stories?'))).toBe(true);
    // 펼친 뒤 — 개별 과거 카드가 실제로 서고(#99), 묶음 카드(3줄 텍스트)는 사라진다.
    expect(container.textContent).toContain('Past Story');
    expect(container.textContent).not.toContain('안에서 이어진 것');
  });

  it('collapses back when the expanded card is clicked again (다시 누르면 접힙니다)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/analytics/epic-flow-nodes')) {
        return jsonResponse({
          data: {
            epic_id: 'e1', now: { total: 1, items: [NOW_ITEM] }, upcoming: { total: 0, shown: 0, items: [] },
            past: { total: 1 }, blocked_count: 0, last_changed_at: null,
          },
        });
      }
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      if (url.includes('/api/goals/e1/reference-candidates')) return jsonResponse([]);
      if (url.startsWith('/api/stories?')) {
        return jsonResponse({ data: [{ id: 'past-1', story_number: 99, title: 'Past Story', status: 'done' }], meta: { hasMore: false, nextCursor: null } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(wrap(<FlowEpicNodes projectId="p1" epicId="e1" epicTitle="Epic 1" onSelectStory={() => {}} memberMap={{}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    const bundleButton = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('완료 1'));
    await act(async () => { bundleButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });
    expect(container.textContent).toContain('Past Story');

    const collapseButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('다시 누르면 접힙니다'));
    expect(collapseButton).not.toBeUndefined();
    await act(async () => { collapseButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });

    expect(container.textContent).not.toContain('Past Story');
    expect(bundleButton()).not.toBeUndefined(); // 묶음 카드가 다시 선다.
  });
});
