// story #2191(#2231 규약 A) — BE(#2540)가 GET /api/v2/docs 응답을 배열에서
// {data, meta:{has_more, next_cursor}}로 바꿨다(list/getBySlug 둘 다). FE가 cursor를
// 그대로 왕복시키는지, {data,meta}를 {items,hasMore,nextCursor}로 정확히 언랩하는지가
// 이 스위트의 본체다 — 놓치면 사이드바 문서 트리 "더 보기"가 아무 것도 안 붙는다.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiDocRepository } from './ApiDocRepository';

describe('ApiDocRepository.list — cursor 전달 + {data,meta} 응답 언랩 (#2191)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 'doc-1', parent_id: null, title: 't', slug: 's', icon: null, tags: null, sort_order: 0, is_folder: false, updated_at: '2026-01-01T00:00:00+00:00' }],
        meta: { has_more: true, next_cursor: '0:doc-1' },
      }),
    })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);
  });

  it('cursor가 있으면 요청 URL에 그대로 실린다(불투명 문자열 — 파싱 없이 왕복)', async () => {
    const repo = new ApiDocRepository('token');
    await repo.list({ project_id: 'proj-1', limit: 20, cursor: '5:doc-0' });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).toContain(`cursor=${encodeURIComponent('5:doc-0')}`);
  });

  it('cursor가 없으면 요청 URL에 안 실린다(기존 무커서 호출 회귀 0)', async () => {
    const repo = new ApiDocRepository('token');
    await repo.list({ project_id: 'proj-1', limit: 20 });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).not.toContain('cursor=');
  });

  it('{data,meta} 응답을 {items,hasMore,nextCursor}로 정확히 언랩한다', async () => {
    const repo = new ApiDocRepository('token');
    const result = await repo.list({ project_id: 'proj-1' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe('doc-1');
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('0:doc-1');
  });
});

describe('ApiDocRepository.getBySlug — 단건 조회도 {data,meta} 봉투를 언랩한다 (#2191)', () => {
  it('data[0]에서 첫 문서를 찾아 단건 조회로 이어간다', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [{ id: 'doc-1', slug: 'my-doc' }], meta: { has_more: false, next_cursor: null } }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ id: 'doc-1', slug: 'my-doc', content: '본문' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const repo = new ApiDocRepository('token');
    const doc = await repo.getBySlug('proj-1', 'my-doc');

    expect(doc.content).toBe('본문');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('data가 빈 배열이면 Doc not found를 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: [], meta: { has_more: false, next_cursor: null } }),
    })));

    const repo = new ApiDocRepository('token');
    await expect(repo.getBySlug('proj-1', 'missing')).rejects.toThrow('Doc not found: missing');
  });
});
