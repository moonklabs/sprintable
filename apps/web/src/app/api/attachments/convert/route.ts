import { getServerSession } from '@/lib/db/server';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';

// story #2803 — pptx 인앱 미리보기: BE 변환 파이프(office_conversion.py, story #2771)로
// 넘기는 얇은 프록시. 인가·캐시·변환 로직은 전부 BE 권위(그라운딩 doc 84ef0cb7 §7-3) —
// 이 라우트는 세션 토큰을 얹어 그대로 위임하고 상태코드만 우리 응답 포맷으로 번역한다.
//
// POST /api/attachments/convert?asset_id=<uuid> → BE POST /api/v2/attachments/{asset_id}/convert
const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
// 까디르군 QA(#2803) — asset_id를 검증 없이 BE 경로 세그먼트에 직접 보간하고 있었다(경로조작
// 이론 위험). apps/web/src/app/api/assets/[id]/route.ts와 동일 패턴으로 UUID 형식만 통과.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const session = await getServerSession().catch(() => null);
    if (!session) return ApiErrors.unauthorized();

    const { searchParams } = new URL(request.url);
    const assetId = searchParams.get('asset_id');
    if (!assetId) return ApiErrors.badRequest('asset_id is required');
    if (!UUID_RE.test(assetId)) return ApiErrors.badRequest('invalid asset id');

    const beUrl = new URL(`/api/v2/attachments/${assetId}/convert`, FASTAPI_URL());
    const beRes = await fetch(beUrl.toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: 'no-store',
    });

    if (beRes.status === 403) return ApiErrors.forbidden('첨부 접근 권한이 없습니다');
    if (beRes.status === 404) return ApiErrors.notFound('asset not found');
    if (beRes.status === 422) return ApiErrors.badRequest('변환 가능한 오피스 문서가 아닙니다');
    // BE office_conversion.ConversionUnavailable — 변환 파이프 미배선 env(dev 전용 하드게이트 등).
    if (beRes.status === 503) return apiError('CONVERSION_UNAVAILABLE', '변환 서비스가 아직 준비되지 않았습니다', 503);
    // BE office_conversion.ConversionFailed — Gotenberg 왕복 실패.
    if (beRes.status === 502) return apiError('CONVERSION_FAILED', '문서 변환에 실패했습니다', 502);
    if (!beRes.ok) return ApiErrors.badRequest('conversion request failed');

    const body = (await beRes.json()) as { asset_id?: string; name?: string; content_type?: string };
    return apiSuccess(body);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
