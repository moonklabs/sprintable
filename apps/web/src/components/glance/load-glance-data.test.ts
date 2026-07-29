import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGlanceData } from './load-glance-data';

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => ({ data }) } as Response;
}

function mockEmptyFetch() {
  return vi.fn(async (url: string) => {
    if (url.startsWith('/api/goals')) return jsonResponse([]);
    if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
    if (url.startsWith('/api/team-members')) return jsonResponse([]);
    // 실 BE shape(activity_logs.py ActivityLogListResponse) — flat 배열 아님. 이 mock이 예전엔
    // jsonResponse([])(틀린 shape)였고, 그게 로드맵 blank의 진짜 근본(items.filter is not a
    // function)을 이 테스트 스위트가 못 잡았던 이유였다(2026-07-11 grounding).
    if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
    // 예외 스트림(#2097) — BE AttentionResponse{items} shape. 프록시가 apiSuccess로 감싸 {data:{items}}.
    if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
    return jsonResponse([]);
  });
}

describe('loadGlanceData (§10 데이터 소스 4종 단순 1회 fetch — dedup/캐시는 불필요한 복잡도로 판명돼 걷어냄, c3d1565d)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves an empty-but-valid GlanceData when every source is genuinely empty', async () => {
    vi.stubGlobal('fetch', mockEmptyFetch());
    const data = await loadGlanceData('proj-a');
    // 2D 재설계(dee92c96): GlanceData에 hero 필드 추가(active 에픽/story 없으면 전부 빈값·no-fiction).
    expect(data).toEqual({
      roadmap: [], totalEpicCount: 0, collaboration: [], events: [],
      activeEpicTitle: null, heroStory: null, memberMap: {}, attentionSignals: [], heroEnvelope: null,
      // codex-silent-defect-sweep D-7 — 진짜 빈 데이터(fetch 성공, 내용 0건)는 partialErrors가
      // 전부 false여야 한다(fetch 실패와 구분되는 것이 이 필드의 존재 이유). story #2298: `stories`
      // 필드는 그 fetch 자체가 없어져 이 타입에서 삭제됐다.
      partialErrors: { overview: false, members: false, activity: false, attention: false },
    });
  });

  it('includes ?include=glance in the goals request URL(story #2298/#2303 — 웨이브②③을 웨이브①로 흡수)', async () => {
    const fetchMock = mockEmptyFetch();
    vi.stubGlobal('fetch', fetchMock);
    await loadGlanceData('proj-a');
    const goalsCall = fetchMock.mock.calls.find(([url]) => (url as string).startsWith('/api/goals'));
    expect(goalsCall?.[0]).toContain('include=glance');
  });

  it('derives collaboration from participant_ids on the goals(+glance) response — no per-epic story-list fetch', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) {
        return jsonResponse([
          { id: 'e1', title: 'Epic One', status: 'active', created_at: '2026-07-01T00:00:00Z', participant_ids: ['m1', 'm2'], focal_story: null },
        ]);
      }
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([{ id: 'm1', name: '미르코 페트로비치' }, { id: 'm2', name: '유나 홀름' }]);
      if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const data = await loadGlanceData('proj-collab');
    expect(data.collaboration).toEqual([
      { epicId: 'e1', collaborators: [{ id: 'm1', name: '미르코 페트로비치' }, { id: 'm2', name: '유나 홀름' }] },
    ]);
    // ⛔fetchJson()이 .catch(()=>null)로 예외를 삼키므로 mock 안에서 throw하는 방식은
    // "회귀 시 조용히 통과하는 가드"가 된다(mutation-verify 중 직접 발견 — 삼켜진 예외는
    // 테스트를 실패시키지 못했다). 실제로 나간 URL을 mock.calls에서 직접 세는 방식만 신뢰 가능.
    const calledUrls = fetchMock.mock.calls.map(([u]) => u as string);
    expect(calledUrls.some((u) => u.startsWith('/api/stories'))).toBe(false);
    expect(calledUrls.some((u) => u.startsWith('/api/glance/hero'))).toBe(false);
  });

  it('builds heroStory + heroEnvelope from focal_story on the active epic — no separate hero fetch', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) {
        return jsonResponse([{
          id: 'e1', title: 'Epic One', status: 'active', created_at: '2026-07-01T00:00:00Z',
          participant_ids: [],
          focal_story: {
            id: 's1', title: 'Story One', status: 'in-progress', assignee_id: null, assignee_ids: ['a1', 'h1'],
            proof_count: 2, auto_verify: 'passed',
            gate: { gate_type: 'merge', requires_human: true },
            trust: { self_reported: true, human_verified: false, human_verified_by: null, human_verified_at: null },
          },
        }]);
      }
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const data = await loadGlanceData('proj-hero');
    const calledUrls = fetchMock.mock.calls.map(([u]) => u as string);
    expect(calledUrls.some((u) => u.startsWith('/api/stories'))).toBe(false);
    expect(calledUrls.some((u) => u.startsWith('/api/glance/hero'))).toBe(false);
    expect(data.heroStory).toEqual({ id: 's1', title: 'Story One', status: 'in-progress', assignee_id: null, assignee_ids: ['a1', 'h1'] });
    expect(data.heroEnvelope).toEqual({
      proof_count: 2, auto_verify: 'passed',
      gate: { gate_type: 'merge', requires_human: true },
      trust: { self_reported: true, human_verified: false, human_verified_by: null, human_verified_at: null },
    });
  });

  it('heroStory/heroEnvelope stay null together when the active epic has no focal_story (no in-progress story)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) {
        return jsonResponse([{ id: 'e1', title: 'Epic One', status: 'active', created_at: '2026-07-01T00:00:00Z', participant_ids: [], focal_story: null }]);
      }
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-no-hero');
    expect(data.heroStory).toBeNull();
    expect(data.heroEnvelope).toBeNull();
  });

  it('unwraps the attention envelope {data:{items}} into attentionSignals — 형상 불일치 crash 없이 실신호 배선', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) return jsonResponse([]);
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
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
      if (url.startsWith('/api/goals')) return jsonResponse([]);
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      if (url.startsWith('/api/glance/attention')) return { ok: false, json: async () => ({}) } as Response;
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-attn-fail');
    expect(data.attentionSignals).toEqual([]);
  });

  it('does not throw when activity-logs returns the real BE envelope shape {items,total,limit,offset} (not a flat array) — 로드맵 blank 진짜 근본 회귀가드', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) return jsonResponse([]);
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/activity-logs')) {
        return jsonResponse({
          items: [{ id: 'a1', actor_type: 'human', action: 'story.status_changed', entity_type: 'story', entity_title: 'x', created_at: '2026-07-10T00:00:00Z' }],
          total: 1, limit: 20, offset: 0,
        });
      }
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-b');
    expect(data.events).toHaveLength(1);
    expect(data.events[0]!.id).toBe('a1');
  });

  it('rejects when the epics fetch fails (essential source — failure must not be mistaken for "0 epics")', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) return { ok: false, json: async () => ({}) } as Response;
      if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      return jsonResponse([]);
    }));
    await expect(loadGlanceData('proj-c')).rejects.toThrow();
  });

  it('fetches fresh every call (no dedup/memoization — each call issues its own network round trip)', async () => {
    vi.stubGlobal('fetch', mockEmptyFetch());
    await loadGlanceData('proj-d');
    await loadGlanceData('proj-d');
    // story #2298: 고정 엔드포인트 수(5: epics+glance·overview·members·activity·attention) 자체는
    // 그대로다 — 줄어든 건 이 5개에 "얹혀 있던" 가변 웨이브다(에픽 수만큼의 story-list N건 +
    // 조건부 hero 1건, 이 mock엔 아예 없어서 숫자로는 안 보인다 — 그 웨이브가 실제로 안 나가는
    // 것은 위 "no per-epic story-list fetch"/"no separate hero fetch" 테스트가 throw로 잡는다).
    expect(vi.mocked(fetch).mock.calls.length).toBe(10); // 5 endpoints × 2 calls (epics·overview·members·activity·attention)
  });
});
