import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCachedGlanceData, loadGlanceData } from './load-glance-data';

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

describe('getCachedGlanceData (해소된 데이터 module-level 캐시 — 2차 근본 fix, dedup만으론 부족했음)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockEmptyFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null before any load has ever settled for a projectId', () => {
    expect(getCachedGlanceData('proj-never-loaded')).toBeNull();
  });

  it('is populated unconditionally once loadGlanceData settles — this is what makes a remounted instance able to read data synchronously without ever awaiting', async () => {
    expect(getCachedGlanceData('proj-f')).toBeNull();
    await loadGlanceData('proj-f');
    expect(getCachedGlanceData('proj-f')).toEqual({ roadmap: [], totalEpicCount: 0, collaboration: [], events: [] });
  });

  it('keeps the resolved cache after the in-flight entry is cleared (not a short-lived cache tied to the in-flight window)', async () => {
    await loadGlanceData('proj-g');
    // in-flight map entry is gone by now (loadGlanceData already resolved), but the resolved cache persists.
    expect(getCachedGlanceData('proj-g')).not.toBeNull();
  });

  it('overwrites with the freshest data on a subsequent load rather than accumulating stale copies', async () => {
    await loadGlanceData('proj-h');
    const first = getCachedGlanceData('proj-h');
    await loadGlanceData('proj-h');
    const second = getCachedGlanceData('proj-h');
    expect(second).toEqual(first); // same shape (mock always returns empty) but a fresh object from the 2nd fetch
    expect(vi.mocked(fetch).mock.calls.length).toBe(8); // confirms a real 2nd fetch happened, not a cache short-circuit
  });

  function mockFetchWithEpicsFailure(epicsShouldFail: () => boolean) {
    return vi.fn(async (url: string) => {
      if (url.startsWith('/api/epics')) {
        if (epicsShouldFail()) return { ok: false, json: async () => ({}) } as Response;
        return jsonResponse([]);
      }
      if (url.startsWith('/api/dashboard/overview')) return jsonResponse({ project_status: { epics: [] } });
      return jsonResponse([]);
    });
  }

  it('never caches a result when the epics fetch itself failed (라이브 재현 — 실패를 "에픽 0개"로 오인해 캐시 오염하던 버그)', async () => {
    vi.stubGlobal('fetch', mockFetchWithEpicsFailure(() => true));
    await expect(loadGlanceData('proj-i')).rejects.toThrow();
    expect(getCachedGlanceData('proj-i')).toBeNull();
  });

  it('lets a retry after an epics failure succeed and populate the cache normally', async () => {
    let epicsShouldFail = true;
    vi.stubGlobal('fetch', mockFetchWithEpicsFailure(() => epicsShouldFail));
    await expect(loadGlanceData('proj-j')).rejects.toThrow();
    expect(getCachedGlanceData('proj-j')).toBeNull();

    epicsShouldFail = false;
    await loadGlanceData('proj-j');
    expect(getCachedGlanceData('proj-j')).not.toBeNull();
  });
});
