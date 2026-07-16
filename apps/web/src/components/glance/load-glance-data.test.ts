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
    });
  });

  it('fetches + unwraps the hero envelope for the focal story of the active epic (form {data:{…}})', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) return jsonResponse([{ id: 'e1', title: 'Epic One', status: 'active', created_at: '2026-07-01T00:00:00Z' }]);
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      if (url.startsWith('/api/stories')) return jsonResponse([{ id: 's1', epic_id: 'e1', assignee_id: null, title: 'Story One', status: 'in-progress' }]);
      if (url.startsWith('/api/glance/hero')) {
        return jsonResponse({
          story_id: 's1', claim: 'Story One', status: 'in-progress', proof_count: 2, auto_verify: 'passed',
          gate: { status: 'pending', gate_type: 'merge', requires_human: true, decision_basis: null, auto_decision_reason: null },
          trust: { self_reported: true, human_verified: false, human_verified_by: null, human_verified_at: null },
        });
      }
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-hero');
    expect(data.heroStory?.id).toBe('s1');
    expect(data.heroEnvelope).not.toBeNull();
    expect(data.heroEnvelope!.proof_count).toBe(2);
    expect(data.heroEnvelope!.auto_verify).toBe('passed');
    expect(data.heroEnvelope!.gate?.gate_type).toBe('merge');
  });

  it('leaves heroEnvelope null when the hero fetch fails (not-ok) — minimal render fallback, no throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/goals')) return jsonResponse([{ id: 'e1', title: 'Epic One', status: 'active', created_at: '2026-07-01T00:00:00Z' }]);
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      if (url.startsWith('/api/team-members')) return jsonResponse([]);
      if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      if (url.startsWith('/api/glance/attention')) return jsonResponse({ items: [] });
      if (url.startsWith('/api/stories')) return jsonResponse([{ id: 's1', epic_id: 'e1', assignee_id: null, title: 'Story One', status: 'in-progress' }]);
      if (url.startsWith('/api/glance/hero')) return { ok: false, json: async () => ({}) } as Response;
      return jsonResponse([]);
    }));
    const data = await loadGlanceData('proj-hero-fail');
    expect(data.heroStory?.id).toBe('s1');
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
    expect(vi.mocked(fetch).mock.calls.length).toBe(10); // 5 endpoints × 2 calls (epics·overview·members·activity·attention)
  });
});
