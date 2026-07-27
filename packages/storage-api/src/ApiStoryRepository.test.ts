// story 083176e8 — 까심 #2148 QA가 정확히 이 파일의 list() query 객체에서 `q` 소실을 잡았다
// (fetch-spy 실측: 검색어를 입력해도 요청 URL에 q가 안 실려 무필터 결과만 반환). 이 스위트는
// 정확히 그 지점을 직접 재현 가능한 형태로 봉쇄한다 — StoryPickerDialog 쪽 테스트는 브라우저
// fetch→/api/stories 경계까지만 검증하고 그 아래(Next.js 프록시→ApiStoryRepository→BE) 경로는
// 못 건드리므로, 이 유닛 테스트가 그 갭을 정확히 메운다.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiStoryRepository } from './ApiStoryRepository';

describe('ApiStoryRepository.list — q(제목검색) 파라미터가 실제 요청 URL에 실린다', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);
  });

  it('includes q in the outgoing query string when filters.q is set (까심이 잡은 정확한 회귀 지점)', async () => {
    const repo = new ApiStoryRepository('token');
    await repo.list({ project_id: 'proj-1', q: '로그인' });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).toContain(`q=${encodeURIComponent('로그인')}`);
  });

  it('omits q from the query string when filters.q is undefined (기존 무쿼리 호출 회귀 0)', async () => {
    const repo = new ApiStoryRepository('token');
    await repo.list({ project_id: 'proj-1' });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).not.toContain('q=');
  });
});
