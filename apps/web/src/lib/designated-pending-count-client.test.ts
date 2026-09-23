// story #4171 — designated-pending-count 진행 중 요청 공유 계약.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));

import { fetchDesignatedPendingCount } from './designated-pending-count-client';
import { setEffectiveOrgId, setEffectiveProjectId } from '@/lib/project-context-client';

const ok = (count: number) => new Response(JSON.stringify({ count }), { status: 200 });

beforeEach(() => { fetchWithAuthMock.mockReset(); setEffectiveOrgId(undefined); setEffectiveProjectId(undefined); });

describe('fetchDesignatedPendingCount', () => {
  it('사이드바·탭바가 동시에 부르면 네트워크 1회를 나눠 쓴다', async () => {
    fetchWithAuthMock.mockResolvedValue(ok(3));
    expect(await Promise.all([fetchDesignatedPendingCount(), fetchDesignatedPendingCount()])).toEqual([3, 3]);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('응답 뒤 호출(폴링·포커스)은 다시 묻는다 — 저장 값 없음', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(ok(3)).mockResolvedValueOnce(ok(1));
    expect(await fetchDesignatedPendingCount()).toBe(3);
    expect(await fetchDesignatedPendingCount()).toBe(1);
  });

  it('실패·예외는 null(배지를 0으로 덮지 않는다)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(new Response(null, { status: 500 })).mockRejectedValueOnce(new Error('offline'));
    expect(await fetchDesignatedPendingCount()).toBeNull();
    expect(await fetchDesignatedPendingCount()).toBeNull();
  });

  it('org 전환 직전에 출발한 요청이 진행 중이어도 전환 뒤 호출은 합류하지 않는다(맥락 키)', async () => {
    let resolveA!: (r: Response) => void;
    fetchWithAuthMock
      .mockImplementationOnce(() => new Promise<Response>((r) => { resolveA = r; }))
      .mockResolvedValueOnce(ok(7));
    setEffectiveOrgId('org-a'); setEffectiveProjectId('p-a');
    const a = fetchDesignatedPendingCount();
    setEffectiveOrgId('org-b'); setEffectiveProjectId('p-b');
    const b = fetchDesignatedPendingCount();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    resolveA(ok(2));
    expect(await b).toBe(7);
    expect(await a).toBe(2);
  });
});
