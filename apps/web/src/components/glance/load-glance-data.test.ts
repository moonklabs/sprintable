import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGlanceData } from './load-glance-data';

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => ({ data }) } as Response;
}

function mockEmptyFetch() {
  return vi.fn(async (url: string) => {
    if (url.startsWith('/api/epics')) return jsonResponse([]);
    if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
    if (url.startsWith('/api/team-members')) return jsonResponse([]);
    if (url.startsWith('/api/activity-logs')) return jsonResponse([]);
    return jsonResponse([]);
  });
}

describe('loadGlanceData (module-level in-flight dedupe — 재마운트 커밋-취소 레이스 fix)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockEmptyFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares a single in-flight promise across two concurrent calls for the same projectId (remount-safe dedupe)', async () => {
    const p1 = loadGlanceData('proj-a');
    const p2 = loadGlanceData('proj-a');
    expect(p1).toBe(p2); // same promise object — a remounted instance awaits the SAME in-flight work
    await Promise.all([p1, p2]);
    // 4 base endpoints, called once total (not once per caller) — dedupe confirmed.
    expect(vi.mocked(fetch).mock.calls.length).toBe(4);
  });

  it('resolves both callers with the same data once the shared fetch settles', async () => {
    const [a, b] = await Promise.all([loadGlanceData('proj-b'), loadGlanceData('proj-b')]);
    expect(a).toEqual({ roadmap: [], totalEpicCount: 0, collaboration: [], events: [] });
    expect(b).toEqual(a);
  });

  it('clears the in-flight cache after settling so a later call triggers a fresh fetch (no permanent stale cache)', async () => {
    await loadGlanceData('proj-c');
    expect(vi.mocked(fetch).mock.calls.length).toBe(4);
    await loadGlanceData('proj-c');
    expect(vi.mocked(fetch).mock.calls.length).toBe(8); // second cycle re-fetched, not reused
  });

  it('does not share in-flight work across different projectIds', async () => {
    const p1 = loadGlanceData('proj-d');
    const p2 = loadGlanceData('proj-e');
    expect(p1).not.toBe(p2);
    await Promise.all([p1, p2]);
    expect(vi.mocked(fetch).mock.calls.length).toBe(8);
  });
});
