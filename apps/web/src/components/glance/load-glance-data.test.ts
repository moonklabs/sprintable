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
    // story #2224(선생님 정정 2026-07-30): collaboration·events·activeEpicTitle 필드 삭제(소비처
    // CollaborationMap·LiveStream·glance-board.tsx가 /glance 삭제와 함께 전부 죽은 코드였다).
    expect(data).toEqual({
      roadmap: [], totalEpicCount: 0, heroStory: null, memberMap: {}, attentionSignals: [], heroEnvelope: null,
      // codex-silent-defect-sweep D-7 — 진짜 빈 데이터(fetch 성공, 내용 0건)는 partialErrors가
      // 전부 false여야 한다(fetch 실패와 구분되는 것이 이 필드의 존재 이유). story #2298: `stories`
      // 필드는 그 fetch 자체가 없어져 이 타입에서 삭제됐다.
      partialErrors: { overview: false, members: false, attention: false },
    });
  });

  it('includes ?include=glance in the goals request URL(story #2298/#2303 — 웨이브②③을 웨이브①로 흡수)', async () => {
    const fetchMock = mockEmptyFetch();
    vi.stubGlobal('fetch', fetchMock);
    await loadGlanceData('proj-a');
    const goalsCall = fetchMock.mock.calls.find(([url]) => (url as string).startsWith('/api/goals'));
    expect(goalsCall?.[0]).toContain('include=glance');
  });

  it('does not fetch /api/activity-logs (story #2224 — 유일 소비처 LiveStream이 죽은 코드라 fetch 자체를 제거)', async () => {
    const fetchMock = mockEmptyFetch();
    vi.stubGlobal('fetch', fetchMock);
    await loadGlanceData('proj-a');
    const calledUrls = fetchMock.mock.calls.map(([u]) => u as string);
    expect(calledUrls.some((u) => u.startsWith('/api/activity-logs'))).toBe(false);
  });

  it('builds memberMap from /api/team-members (still consumed by GlanceHero human/agent display)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) return jsonResponse([]);
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([{ id: 'm1', name: '미르코 페트로비치', type: 'agent' }]);
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const data = await loadGlanceData('proj-members');
    expect(data.memberMap).toEqual({ m1: { name: '미르코 페트로비치', type: 'agent' } });
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
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-no-hero');
    expect(data.heroStory).toBeNull();
    expect(data.heroEnvelope).toBeNull();
  });

  it('picks an active epic that actually has a focal_story over an earlier active epic with none(결함 fix 2026-07-30 — 선생님 실측 "열린 스토리가 없다": active 에픽 다수 중 «첫 번째»가 무조건 뽑혀 실제 진행중 스토리가 있는 다른 active 에픽을 두고 빈 에픽이 hero로 선택되던 버그)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) {
        return jsonResponse([
          { id: 'e-empty', title: 'E-CHAT-REALTIME(진행중 없음)', status: 'active', created_at: '2026-07-01T00:00:00Z', participant_ids: [], focal_story: null },
          { id: 'e-has-work', title: 'E-UI-DAEGBYEON(진행중 있음)', status: 'active', created_at: '2026-07-02T00:00:00Z', participant_ids: [], focal_story: {
            id: 's-real', title: '실제 진행중 스토리', status: 'in-progress', assignee_id: null, assignee_ids: [],
            proof_count: 0, auto_verify: null, gate: null,
            trust: { self_reported: false, human_verified: false, human_verified_by: null, human_verified_at: null },
          } },
        ]);
      }
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-multi-active');
    expect(data.heroStory?.id).toBe('s-real');
  });

  it('story #2341 AC2: among multiple active epics that each have a focal_story, picks the most recently updated one(updated_at tie-break — "먼저 오는 하나"가 아니라 "가장 최근에 움직인 하나")', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) {
        return jsonResponse([
          {
            id: 'e-stale', title: 'E-STALE(오래전 갱신)', status: 'active',
            created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z', participant_ids: [],
            focal_story: {
              id: 's-stale', title: '오래된 진행중 스토리', status: 'in-progress', assignee_id: null, assignee_ids: [],
              proof_count: 0, auto_verify: null, gate: null,
              trust: { self_reported: false, human_verified: false, human_verified_by: null, human_verified_at: null },
            },
          },
          {
            // 배열 순서상 뒤에 오지만(먼저 오는 하나가 아님) updated_at이 더 최근 — tie-break가
            // 순서가 아니라 최신성으로 고르는지가 이 테스트의 핵심.
            id: 'e-fresh', title: 'E-FRESH(방금 갱신)', status: 'active',
            created_at: '2026-05-01T00:00:00Z', updated_at: '2026-08-27T00:00:00Z', participant_ids: [],
            focal_story: {
              id: 's-fresh', title: '방금 진행중 스토리', status: 'in-progress', assignee_id: null, assignee_ids: [],
              proof_count: 0, auto_verify: null, gate: null,
              trust: { self_reported: false, human_verified: false, human_verified_by: null, human_verified_at: null },
            },
          },
        ]);
      }
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-recency-tiebreak');
    expect(data.heroStory?.id).toBe('s-fresh');
  });

  it('falls back to the first active epic when none of the active epics have a focal_story(진짜 0건 — 정직한 빈 상태 유지)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) {
        return jsonResponse([
          { id: 'e1', title: 'Epic One', status: 'active', created_at: '2026-07-01T00:00:00Z', participant_ids: [], focal_story: null },
          { id: 'e2', title: 'Epic Two', status: 'active', created_at: '2026-07-02T00:00:00Z', participant_ids: [], focal_story: null },
        ]);
      }
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-all-empty-active');
    expect(data.heroStory).toBeNull();
  });

  it('unwraps the attention envelope {data:{items}} into attentionSignals — 형상 불일치 crash 없이 실신호 배선', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) return jsonResponse([]);
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
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
      if (url.startsWith('/api/goals')) return jsonResponse([]);
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/glance/attention')) return { ok: false, json: async () => ({}) } as Response;
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-attn-fail');
    expect(data.attentionSignals).toEqual([]);
  });

  it('rejects when the epics fetch fails (essential source — failure must not be mistaken for "0 epics")', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) return { ok: false, json: async () => ({}) } as Response;
      return jsonResponse([]);
    }));
    await expect(loadGlanceData('proj-c')).rejects.toThrow();
  });

  it('fetches fresh every call (no dedup/memoization — each call issues its own network round trip)', async () => {
    vi.stubGlobal('fetch', mockEmptyFetch());
    await loadGlanceData('proj-d');
    await loadGlanceData('proj-d');
    // story #2224: 고정 엔드포인트 수가 5→4로 줄었다(activity-logs 제거) — epics+glance·
    // overview·members·attention.
    expect(vi.mocked(fetch).mock.calls.length).toBe(8); // 4 endpoints × 2 calls
  });
});
