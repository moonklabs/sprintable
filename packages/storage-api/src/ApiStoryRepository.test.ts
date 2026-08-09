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

describe('ApiStoryRepository.list — story_number(#2283 참조해소) 파라미터가 실제 요청 URL에 실린다', () => {
  // BE(stories.py:93)는 이미 story_number 필터를 받는데 이 query 객체엔 없었다 — q 소실
  // (083176e8)과 같은 클래스, 이번엔 story_number가 조립 지점에서만 빠져 있었다.
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);
  });

  it('includes story_number in the outgoing query string when filters.story_number is set', async () => {
    const repo = new ApiStoryRepository('token');
    await repo.list({ project_id: 'proj-1', story_number: 2249 });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).toContain('story_number=2249');
  });

  it('omits story_number from the query string when filters.story_number is undefined', async () => {
    const repo = new ApiStoryRepository('token');
    await repo.list({ project_id: 'proj-1' });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).not.toContain('story_number=');
  });
});

describe('ApiStoryRepository.list — unattached(story #2534 E-FLOW-V4 S4) 파라미터가 실제 요청 URL에 실린다', () => {
  // BE(stories.py:137)는 이미 unattached 쿼리를 받는데 이 query 객체엔 없었다 — q 소실
  // (083176e8)·story_number 소실(#2283)과 같은 클래스, 이번엔 unattached가 빠져 있었다.
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);
  });

  it('includes unattached in the outgoing query string when filters.unattached is true', async () => {
    const repo = new ApiStoryRepository('token');
    await repo.list({ project_id: 'proj-1', unattached: true });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).toContain('unattached=true');
  });

  it('omits unattached from the query string when filters.unattached is undefined', async () => {
    const repo = new ApiStoryRepository('token');
    await repo.list({ project_id: 'proj-1' });

    const requestedUrl = (fetchMock.mock.calls[0]![0] as URL | string).toString();
    expect(requestedUrl).not.toContain('unattached=');
  });
});
