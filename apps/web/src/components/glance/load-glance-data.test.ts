import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGlanceData } from './load-glance-data';

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => ({ data }) } as Response;
}

function mockEmptyFetch() {
  return vi.fn(async (url: string) => {
    if (url.startsWith('/api/epics')) return jsonResponse([]);
    if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
    if (url.startsWith('/api/team-members')) return jsonResponse([]);
    // 실 BE shape(activity_logs.py ActivityLogListResponse) — flat 배열 아님. 이 mock이 예전엔
    // jsonResponse([])(틀린 shape)였고, 그게 로드맵 blank의 진짜 근본(items.filter is not a
    // function)을 이 테스트 스위트가 못 잡았던 이유였다(2026-07-11 grounding).
    if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
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
    expect(data).toEqual({ roadmap: [], totalEpicCount: 0, collaboration: [], events: [] });
  });

  it('does not throw when activity-logs returns the real BE envelope shape {items,total,limit,offset} (not a flat array) — 로드맵 blank 진짜 근본 회귀가드', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/epics')) return jsonResponse([]);
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
      if (url.startsWith('/api/epics')) return { ok: false, json: async () => ({}) } as Response;
      if (url.startsWith('/api/activity-logs')) return jsonResponse({ items: [], total: 0, limit: 20, offset: 0 });
      return jsonResponse([]);
    }));
    await expect(loadGlanceData('proj-c')).rejects.toThrow();
  });

  it('fetches fresh every call (no dedup/memoization — each call issues its own network round trip)', async () => {
    vi.stubGlobal('fetch', mockEmptyFetch());
    await loadGlanceData('proj-d');
    await loadGlanceData('proj-d');
    expect(vi.mocked(fetch).mock.calls.length).toBe(8); // 4 endpoints × 2 calls
  });
});
