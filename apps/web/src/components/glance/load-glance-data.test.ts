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

  it('story #3126: among multiple active epics that each have a focal_story, picks the one with the most recent latest_story_activity_at(«먼저 오는 하나»가 아니라 «지금 실제로 움직이는 하나»)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) {
        return jsonResponse([
          {
            // ⛔페드루 QA 재지적(2026-08-27, #2341 AC2와 같은 confound 클래스 재발) — «필드
            // 축»(latest_story_activity_at vs updated_at) confound는 첫 판에서 죽였으나
            // «배열순서 축»(scopeRoadmapEpics의 position-없음 created_at ASC 폴백) confound가
            // 남아있었다. 이 표본은 e-stale(질 쪽)의 created_at을 e-fresh보다 «이르게» 둬서
            // 배열상 e-stale이 «먼저» 오게 만든다 — sort를 통째로 제거해도(폴백 배열순서만
            // 남아도) e-stale이 뽑히면 이 tie-break가 진짜 latest_story_activity_at으로
            // 정렬한다는 걸 증명 못 한다. updated_at은 반대로(e-stale이 더 최근) 둬서 옛
            // updated_at 기반 계산이 되살아나도 걸리게 한다(필드축+배열축 이중 confound 제거).
            id: 'e-stale', title: 'E-STALE(배열상 먼저 옴·에픽 row updated_at은 최근·소속 스토리는 조용)', status: 'active',
            created_at: '2026-05-01T00:00:00Z', updated_at: '2026-08-27T00:00:00Z',
            latest_story_activity_at: '2026-06-01T00:00:00Z', participant_ids: [],
            focal_story: {
              id: 's-stale', title: '오래된 진행중 스토리', status: 'in-progress', assignee_id: null, assignee_ids: [],
              proof_count: 0, auto_verify: null, gate: null,
              trust: { self_reported: false, human_verified: false, human_verified_by: null, human_verified_at: null },
            },
          },
          {
            // 배열상 e-stale보다 «뒤»(created_at 늦음)·에픽 row updated_at도 e-stale보다 이르다
            // — 배열순서 폴백으로도, updated_at 기반 계산으로도 이 쪽이 이길 수 없다. 오직
            // latest_story_activity_at가 가장 최신이라는 사실만으로 뽑혀야 이 테스트가 유효.
            id: 'e-fresh', title: 'E-FRESH(배열상 뒤에 옴·에픽 row updated_at은 오래전·소속 스토리가 방금 움직임)', status: 'active',
            created_at: '2026-06-15T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
            latest_story_activity_at: '2026-08-27T00:00:00Z', participant_ids: [],
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

  it('story #3126: an active epic whose focal_story has no latest_story_activity_at(무-non-done 스토리) loses the tie-break to one that has a real value', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) {
        return jsonResponse([
          {
            // e-null(질 쪽)의 created_at을 e-real보다 «이르게» 둬서 배열상 먼저 오게 만든다
            // — sort를 통째로 제거하면 e-null이 뽑혀 이 단언이 깨진다(배열축 confound 제거,
            // 위 tie-break 테스트와 같은 관행).
            id: 'e-null', title: 'E-NULL(배열상 먼저 옴·소속 non-done 스토리 없음)', status: 'active',
            created_at: '2026-05-01T00:00:00Z', updated_at: '2026-08-27T00:00:00Z',
            latest_story_activity_at: null, participant_ids: [],
            focal_story: {
              id: 's-null', title: '스토리', status: 'in-progress', assignee_id: null, assignee_ids: [],
              proof_count: 0, auto_verify: null, gate: null,
              trust: { self_reported: false, human_verified: false, human_verified_by: null, human_verified_at: null },
            },
          },
          {
            id: 'e-real', title: 'E-REAL(배열상 뒤에 옴·실 값 존재)', status: 'active',
            created_at: '2026-07-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z',
            latest_story_activity_at: '2026-06-01T00:00:00Z', participant_ids: [],
            focal_story: {
              id: 's-real', title: '스토리', status: 'in-progress', assignee_id: null, assignee_ids: [],
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
    const data = await loadGlanceData('proj-recency-null-tiebreak');
    expect(data.heroStory?.id).toBe('s-real');
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
