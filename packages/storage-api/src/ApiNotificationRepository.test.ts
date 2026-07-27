// story #2195(#2231 규약 A) — BE(#2538)가 GET /api/v2/notifications 응답을 배열에서
// {data, meta:{has_more, next_cursor}}로 바꿨다. FE가 cursor(before로 매핑)를 실제
// 요청 URL에 실어 보내는지, 그리고 새 응답 형태를 {items, hasMore, nextCursor}로 정확히
// 풀어내는지가 이 스위트의 본체다 — 이걸 놓치면 인박스 "더 보기"가 아무 것도 안 붙는다.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiNotificationRepository } from './ApiNotificationRepository';

describe('ApiNotificationRepository.list — cursor 전달 + {data,meta} 응답 언랩 (#2195)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 'n1', org_id: 'o1', user_id: 'u1', type: 'x', title: 't', body: null, is_read: false, reference_type: null, reference_id: null, created_at: '2026-01-01T00:00:00+00:00' }],
        meta: { has_more: true, next_cursor: '2026-01-01T00:00:00+00:00' },
      }),
    })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);
  });

  it('cursor가 있으면 요청 URL에 before로 실린다', async () => {
    const repo = new ApiNotificationRepository('token');
    await repo.list({ user_id: 'u1', limit: 50, cursor: '2025-12-31T00:00:00+00:00' });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).toContain(`before=${encodeURIComponent('2025-12-31T00:00:00+00:00')}`);
  });

  it('cursor가 없으면 before가 요청 URL에 안 실린다(기존 무커서 호출 회귀 0)', async () => {
    const repo = new ApiNotificationRepository('token');
    await repo.list({ user_id: 'u1', limit: 50 });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).not.toContain('before=');
  });

  it('{data,meta} 응답을 {items,hasMore,nextCursor}로 정확히 언랩한다', async () => {
    const repo = new ApiNotificationRepository('token');
    const result = await repo.list({ user_id: 'u1', limit: 50 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe('n1');
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('2026-01-01T00:00:00+00:00');
  });
});
