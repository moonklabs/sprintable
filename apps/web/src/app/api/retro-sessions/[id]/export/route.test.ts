import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #3778 CHANGES — 로케일 해석은 getLocale()(src/i18n/request.ts, 화면과 동일
// 함수) 하나로 통일했다. 이 라우트는 그 결과 문자열을 그대로 Accept-Language로
// forward만 한다 — 쿠키/헤더 폴백 로직 자체는 request.test.ts가 별도로 고정한다.
const { getOrgProjectAuthContext, proxyToFastapiWithParams, getLocaleMock } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapiWithParams: vi.fn(),
  getLocaleMock: vi.fn(),
}));

vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));
vi.mock('@/i18n/request', () => ({ getLocale: getLocaleMock }));

import { GET } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

function makeRequest() {
  return new Request('http://localhost/api/retro-sessions/session-1/export?project_id=project-1');
}

// story #3774 — BE `retros.py::export_session`은 JSON 봉투가 아니라 마크다운 텍스트를
// `Response(media_type="text/markdown")`로 그대로 준다. 이전엔 이 라우트가 그 응답을
// `.json()`으로 파싱하다 `SyntaxError`(마크다운 첫 글자 `#`)로 죽어 「내보내기」가
// 라이브에서 한 번도 성공한 적 없었다 — 이 스위트가 그 계약을 고정한다.
describe('GET /api/retro-sessions/[id]/export', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    proxyToFastapiWithParams.mockReset();
    getLocaleMock.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(makeAgent());
    getLocaleMock.mockResolvedValue('en');
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
});

describe('GET /api/retro-sessions/[id]/export — story #3778 로케일 forward', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    proxyToFastapiWithParams.mockReset();
    getLocaleMock.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(makeAgent());
    proxyToFastapiWithParams.mockResolvedValue(
      new Response('# doc', { status: 200, headers: { 'Content-Type': 'text/markdown' } }),
    );
  });

  it('⭐getLocale()의 결과(en)를 Accept-Language로 그대로 실어 BE 호출에 넘긴다', async () => {
    getLocaleMock.mockResolvedValue('en');

    await GET(makeRequest(), { params: Promise.resolve({ id: 'session-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v2/retros/[id]/export',
      { id: 'session-1' },
      { extraHeaders: { 'Accept-Language': 'en' } },
    );
  });

  it('getLocale()이 ko를 돌려주면 그대로 ko를 넘긴다', async () => {
    getLocaleMock.mockResolvedValue('ko');

    await GET(makeRequest(), { params: Promise.resolve({ id: 'session-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v2/retros/[id]/export',
      { id: 'session-1' },
      { extraHeaders: { 'Accept-Language': 'ko' } },
    );
  });

  // story #3778 CHANGES(유나 design:changes) — 최초본은 쿠키가 없으면 extraHeaders
  // 자체를 안 보냈다(BE 기본값에 맡김 — 그게 바로 "화면은 en인데 문서는 ko"였던 병의
  // 경로). 지금은 getLocale()이 항상 구체적인 로케일을 돌려주므로(자체 기본값 en까지
  // 포함) extraHeaders가 never undefined다 — 그 자체가 회귀가드.
  it('⭐getLocale()은 항상 구체값을 돌려주므로 extraHeaders가 undefined로 빠지는 경우가 없다', async () => {
    getLocaleMock.mockResolvedValue('en'); // getLocale() 자신의 기본값(쿠키·헤더 둘 다 없을 때)

    await GET(makeRequest(), { params: Promise.resolve({ id: 'session-1' }) });

    const call = proxyToFastapiWithParams.mock.calls[0];
    expect(call?.[3]).toEqual({ extraHeaders: { 'Accept-Language': 'en' } });
    expect(call?.[3]?.extraHeaders).not.toBeUndefined();
  });

  it('인증 실패면 401 — BE 호출 자체를 안 한다', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: 'session-1' }) });

    expect(res.status).toBe(401);
    expect(proxyToFastapiWithParams).not.toHaveBeenCalled();
  });
});
