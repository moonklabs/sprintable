import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGlanceData } from './load-glance-data';

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => ({ data }) } as Response;
}

function mockEmptyFetch() {
  return vi.fn(async (url: string) => {
    if (url.startsWith('/api/team-members')) return jsonResponse([]);
    // 예외 스트림(#2097) — BE AttentionResponse{items} shape. 프록시가 apiSuccess로 감싸 {data:{items}}.
    if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
    return jsonResponse([]);
  });
}

// story #3710(2026-09-09, 페드루 PO 決) — 이 파일은 예전엔 `/api/goals`+`/api/dashboard/
// overview`까지 4개 fetch로 roadmap/totalEpicCount/heroStory/heroEnvelope를 함께 테스트했다.
// 그 필드들의 유일 소비처(flow-client.tsx)가 실제로는 attentionSignals·memberMap만 읽는
// 죽은 경로였음이 확認돼(#3705 그라운딩) story #3710에서 그 경로 자체를 걷어냈다 — 관련
// 테스트도 함께 제거하고, 남는 2개 fetch(team-members·attention)만 pin한다.
describe('loadGlanceData (§10 데이터 소스 2종 단순 1회 fetch — dedup/캐시는 불필요한 복잡도로 판명돼 걷어냄, c3d1565d)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves an empty-but-valid GlanceData when every source is genuinely empty', async () => {
    vi.stubGlobal('fetch', mockEmptyFetch());
    const data = await loadGlanceData('proj-a');
    // codex-silent-defect-sweep D-7 — 진짜 빈 데이터(fetch 성공, 내용 0건)는 partialErrors가
    // 전부 false여야 한다(fetch 실패와 구분되는 것이 이 필드의 존재 이유).
    expect(data).toEqual({
      memberMap: {},
      attentionSignals: [],
      partialErrors: { members: false, attention: false },
    });
  });

  it('fetches exactly team-members + attention — no goals/overview/activity-logs calls(story #3710 — 죽은 로드맵 경로 제거)', async () => {
    const fetchMock = mockEmptyFetch();
    vi.stubGlobal('fetch', fetchMock);
    await loadGlanceData('proj-a');
    const calledUrls = fetchMock.mock.calls.map(([u]) => u as string);
    expect(calledUrls.some((u) => u.startsWith('/api/goals'))).toBe(false);
    expect(calledUrls.some((u) => u.startsWith('/api/dashboard/overview'))).toBe(false);
    expect(calledUrls.some((u) => u.startsWith('/api/activity-logs'))).toBe(false);
    expect(calledUrls.filter((u) => u.startsWith('/api/team-members'))).toHaveLength(1);
    expect(calledUrls.filter((u) => u.startsWith('/api/glance/attention'))).toHaveLength(1);
  });

  it('builds memberMap from /api/team-members (still consumed by NextMakerScreen/GoalStemCard assignee display)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members')) return jsonResponse([{ id: 'm1', name: '미르코 페트로비치', type: 'agent' }]);
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const data = await loadGlanceData('proj-members');
    expect(data.memberMap).toEqual({ m1: { name: '미르코 페트로비치', type: 'agent' } });
  });

  it('unwraps the attention envelope {data:{items}} into attentionSignals — 형상 불일치 crash 없이 실신호 배선', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/glance/attention')) {
        return jsonResponse({ items: [
          { kind: 'merge_ready', story_id: 's1', title: '리뷰 대기 스토리', ref: {} },
          { kind: 'gate_pending', story_id: null, title: null, ref: { approval_id: 'ap1' } }, // title 없음 → 생략
        ] });
      }
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-attn');
    expect(data.attentionSignals).toHaveLength(1);
    expect(data.attentionSignals[0]!.kind).toBe('merge_ready');
    expect(data.attentionSignals[0]!.title).toBe('리뷰 대기 스토리');
  });

  it('degrades attentionSignals to [] when the attention fetch fails (not-ok) without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/glance/attention')) return { ok: false, json: async () => ({}) } as Response;
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-attn-fail');
    expect(data.attentionSignals).toEqual([]);
    expect(data.partialErrors.attention).toBe(true);
  });

  it('degrades memberMap to {} when team-members fetch fails (not-ok), tracked via partialErrors.members', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/team-members')) return { ok: false, json: async () => ({}) } as Response;
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-members-fail');
    expect(data.memberMap).toEqual({});
    expect(data.partialErrors.members).toBe(true);
  });

  it('fetches fresh every call (no dedup/memoization — each call issues its own network round trip)', async () => {
    vi.stubGlobal('fetch', mockEmptyFetch());
    await loadGlanceData('proj-d');
    await loadGlanceData('proj-d');
    // story #3710: 고정 엔드포인트 수가 4→2로 줄었다(에픽+overview 제거).
    expect(vi.mocked(fetch).mock.calls.length).toBe(4); // 2 endpoints × 2 calls
  });
});
