import { cookies } from 'next/headers';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/retro-sessions/:id/export?project_id=X
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    // story #3778(PO 決 2026-09-10) — 영어 로케일 사용자가 내보내면 한국어 문서를 받던
    // 병. BE는 화면의 로케일 쿠키를 자동으로 못 본다(server-to-server 호출) — src/i18n/
    // request.ts와 동일한 쿠키(`locale`)를 여기서 직접 읽어 Accept-Language로 실어
    // 보낸다(BE가 그 값으로 문서 언어를 고른다, retros.py::export_session).
    const cookieStore = await cookies();
    const locale = cookieStore.get('locale')?.value;

    const _r = await proxyToFastapiWithParams(request, '/api/v2/retros/[id]/export', { id }, {
      extraHeaders: locale ? { 'Accept-Language': locale } : undefined,
    });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    // story #3774 — BE(`retros.py::export_session`)는 JSON 봉투가 아니라 마크다운
    // «텍스트»를 `Response(media_type="text/markdown")`로 그대로 준다(FE가 클립보드에
    // 그대로 복사할 원문이라 JSON 왕복이 필요 없는 자리). 이전엔 여기서 `.json()`으로
    // 파싱하다 `SyntaxError`(마크다운 첫 글자 `#`가 JSON으로 안 읽힘)가 나 매번 500으로
    // 죽었다 — 실 성공 경로가 한 번도 없었다. Content-Type으로 분기: JSON이 아니면
    // 텍스트로 읽어 FE가 기대하는 `{ data: { markdown } }` 봉투로 감싼다(FE
    // `retro/[id]/page.tsx::exportSession` 무변 — 그 계약이 이미 유일한 소비처).
    const contentType = _r.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const markdown = await _r.text();
      return apiSuccess({ markdown });
    }
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
