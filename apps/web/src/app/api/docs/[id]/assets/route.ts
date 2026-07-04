import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// S4 Docs Attach → Storage: 업로드된 객체를 자산 레지스트리에 register(+ source_link source_type=doc).
// BE POST /api/v2/docs/{id}/assets {object_path|url, filename, size, mime} → { data: { assetId } } (또는 {id}).
// ⚠️ design-first(디디) — 이 엔드포인트가 아직 없을 수 있다. 그 경우 upstream non-2xx 를 그대로 통과시켜
// FE 업로드 플로우가 error 상태로 graceful 처리(크래시 없음). doc 도메인 envelope 일관(apiSuccess·{data}).
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapiWithParams(request, '/api/v2/docs/[id]/assets', { id });
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
