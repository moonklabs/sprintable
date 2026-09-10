import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { getLocale } from '@/i18n/request';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/retro-sessions/:id/export?project_id=X
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    // story #3778 CHANGES(유나 design:changes 2026-09-10) — 최초본은 `locale` 쿠키를
    // 여기서 직접 읽었는데, 쿠키가 없으면(로케일 스위처를 한 번도 안 건드린 신규
    // 사용자 — 세팅 자리는 locale-switcher.tsx 단 한 곳) 헤더 자체를 안 보내 BE가
    // 자기 기본값(ko)으로 떨어졌다 — 정작 화면은 같은 상황에서 Accept-Language로
    // en을 고르므로(`src/i18n/request.ts::getLocale()`) "화면 폴백과 동형"이라던 주석이
    // 거짓이었다(기본값 다름·헤더 폴백 단계가 아예 빠짐). 해석 로직을 그 함수 하나로
    // 통일 — route는 결과만 그대로 forward한다(BE는 그 문자열 자체를 Accept-Language로
    // 받는다, retros.py::export_session).
    const locale = await getLocale();

    const _r = await proxyToFastapiWithParams(request, '/api/v2/retros/[id]/export', { id }, {
      extraHeaders: { 'Accept-Language': locale },
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
