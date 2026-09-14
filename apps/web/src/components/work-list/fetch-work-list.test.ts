// @vitest-environment jsdom
//
// story #3844(카디르 QA 발견, PR#4268) — fetch-work-list.ts는 실사고 ②(team-members가
// 무-페이지네이션 소스인데 규약 A로 잘못 모델링해 데이터 0건에도 "전부 불러오지
// 못했어요" 배너가 항상 뜨던 결함)를 이 파일에서 고쳤는데 이 파일 자체엔 테스트가
// 0이었다 — 회귀를 아무도 못 잡는 상태. story #3857(FE 프록시 헤더 통과)이 곧 이
// 파일의 agent-runs 호출부를 fetchPage로 바꿀 예정이라 그 전에 team-members가
// 여전히 fetchEnvelope(순수 배열, 페이지네이션 무관) 경로를 타는지 잠가 둔다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

const { fetchWorkList } = await import('./fetch-work-list');

function jsonResponse(body: unknown): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: async () => body };
}

// 규약 A 소스(goals/stories/tasks) — camelCase meta 필수. hasMore:false로 고정해 이 헬퍼
// 자체가 partial에 기여하지 않게 한다(테스트 대상은 team-members 단독 경로).
function regulationAEnvelope(items: unknown[]) {
  return jsonResponse({ data: items, meta: { limit: 100, hasMore: false, nextCursor: null } });
}

// 무-페이지네이션 소스(agent-runs/gates-inbox/team-members/visual-artifacts/hypotheses) —
// FE 프록시가 순수 배열만 돌려주고 meta는 항상 null(apiSuccess(data) 관례).
function plainArrayEnvelope(items: unknown[]) {
  return jsonResponse({ data: items, meta: null });
}

function mockFetchWorkListSources(overrides: { teamMembers?: unknown[] } = {}) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/goals')) return regulationAEnvelope([]);
    if (url.includes('/api/stories')) return regulationAEnvelope([]);
    if (url.includes('/api/tasks')) return regulationAEnvelope([]);
    if (url.includes('/api/agent-runs')) return plainArrayEnvelope([]);
    if (url.includes('/api/gates/inbox')) return plainArrayEnvelope([]);
    if (url.includes('/api/team-members')) return plainArrayEnvelope(overrides.teamMembers ?? []);
    if (url.includes('/api/visual-artifacts')) return plainArrayEnvelope([]);
    if (url.includes('/api/hypotheses')) return plainArrayEnvelope([]);
    throw new Error(`mockFetchWorkListSources: 예상 밖 URL — ${url}`);
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchWorkList — team-members는 무-페이지네이션 소스라 partial에 기여하지 않는다(카디르 QA, PR#4268 실사고② 회귀가드)', () => {
  it('team-members가 데이터 0건이어도 partial=false(다른 소스도 전부 hasMore:false)', async () => {
    mockFetchWorkListSources({ teamMembers: [] });
    const { workList } = await fetchWorkList('proj-1');
    expect(workList.partial).toBe(false);
  });

  it('team-members가 데이터를 여럿 반환해도(meta 없이) partial=false — malformed로 새지 않는다', async () => {
    mockFetchWorkListSources({
      teamMembers: [
        { id: 'm1', type: 'human', name: '사람' },
        { id: 'm2', type: 'agent', name: '미르코' },
      ],
    });
    const { workList } = await fetchWorkList('proj-1');
    expect(workList.partial).toBe(false);
  });

  // ⭐되돌리면 RED — fetch-work-list.ts가 team-members를 fetchEnvelope 대신 규약 A
  // fetchPage로 읽게 되돌아가면, 이 목(mock)은 team-members에 meta:null을 주므로
  // parseCursorMeta가 malformed 판정(hasMore:null) → isPartial()이 true로 접어 아래
  // 단언이 깨진다. 이 목 응답 자체를 바꾸지 않고 fetch-work-list.ts 쪽 구현만 되돌려도
  // 잡히는 자리라는 게 이 테스트의 요점(다음 사람이 fetchPage로 오인해 바꾸는 재발 방지).
  it('team-members 응답에 meta가 없다는 사실 자체가 partial 오탐의 재발 지점이다', async () => {
    mockFetchWorkListSources({ teamMembers: [{ id: 'm1', type: 'human', name: '사람' }] });
    const { workList } = await fetchWorkList('proj-1');
    expect(workList.partial).toBe(false);
  });
});
