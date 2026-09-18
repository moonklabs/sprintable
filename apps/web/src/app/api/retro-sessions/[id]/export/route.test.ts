import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #3786 후속(2026-09-10) — 이 라우트가 직접 풀던 getLocale()→extraHeaders 배선은
// 공통 프록시 계층(fastapi-proxy.ts::proxyToFastapi)의 기본 동작으로 이관됐다(공통층
// 우선, 중복 계산 제거). 로케일 forwarding 자체의 회귀가드는 이제
// apps/web/src/lib/fastapi-proxy.test.ts가 진다 — 이 파일은 이 라우트 고유의 계약
// (markdown 원문 재봉투·401·4xx/5xx 그대로 전달)만 고정한다.
const { getOrgProjectAuthContext, proxyToFastapiWithParams } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapiWithParams: vi.fn(),
}));

vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

// story #3774 — BE `retros.py::export_session`은 JSON 봉투가 아니라 마크다운 텍스트를
// `Response(media_type="text/markdown")`로 그대로 준다. 이전엔 이 라우트가 그 응답을
// `.json()`으로 파싱하다 `SyntaxError`(마크다운 첫 글자 `#`)로 죽어 「내보내기」가
// 라이브에서 한 번도 성공한 적 없었다 — 이 스위트가 그 계약을 고정한다.
describe('GET /api/retro-sessions/[id]/export', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    proxyToFastapiWithParams.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 401 when not authenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost/api/retro-sessions/session-1/export?project_id=project-1'),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(401);
  });

  // ⭐되돌리면 RED — BE의 실제 응답 형(text/markdown 원문)을 그대로 재현한다. `.json()`으로
  // 파싱하는 이전 코드로 되돌리면 이 텍스트("# 회고 제목"으로 시작)가 JSON 파싱에 실패해
  // 500/400으로 죽는다(라이브에서 관측된 정확한 그 실패).
  it('⭐BE가 text/markdown 원문을 주면 200 + { data: { markdown } } 봉투로 감싼다', async () => {
    const markdown = '# 픽셀 로딩 시드\n**Phase:** action\n\n## 잘된 점 (Good)\n- 빨랐다 (3 votes)';
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(markdown, { status: 200, headers: { 'Content-Type': 'text/markdown; charset=utf-8' } }),
    );

    const response = await GET(
      new Request('http://localhost/api/retro-sessions/session-1/export?project_id=project-1'),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { markdown: string } };
    expect(body.data.markdown).toBe(markdown);
    expect(body.data.markdown.startsWith('#')).toBe(true);
  });

  it('BE가 이미 JSON 봉투를 주면 그대로 통과한다(회귀 대비 — 미래에 BE가 JSON으로 바뀌어도 무변)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ markdown: '# from json' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const response = await GET(
      new Request('http://localhost/api/retro-sessions/session-1/export?project_id=project-1'),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { markdown: string } };
    expect(body.data.markdown).toBe('# from json');
  });

  it('BE 4xx/5xx는 그대로 전달한다(봉투 변환 없음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'no access' } }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );

    const response = await GET(
      new Request('http://localhost/api/retro-sessions/session-1/export?project_id=project-1'),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(403);
  });

  it('인증 실패면 401 — BE 호출 자체를 안 한다', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);

    const res = await GET(
      new Request('http://localhost/api/retro-sessions/session-1/export?project_id=project-1'),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(res.status).toBe(401);
    expect(proxyToFastapiWithParams).not.toHaveBeenCalled();
  });

  // story #3786 후속 — 이 라우트가 더는 extraHeaders를 스스로 계산하지 않는다는 것을
  // 고정한다(공통 프록시 계층이 getLocale()을 기본으로 싣는다 — fastapi-proxy.test.ts
  // 「Accept-Language 공통층 기본 forwarding」 블록에서 검증). options 인자 자체를
  // 안 넘기는 3-arg 호출이 이 라우트의 정상 형이다.
  it('proxyToFastapiWithParams를 options 없이(3-arg) 호출한다 — extraHeaders 자체 계산 없음', async () => {
    await GET(
      new Request('http://localhost/api/retro-sessions/session-1/export?project_id=project-1'),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v2/retros/[id]/export',
      { id: 'session-1' },
    );
  });
});
