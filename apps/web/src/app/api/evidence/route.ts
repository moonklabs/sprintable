import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET /api/evidence?work_item_id=&work_item_type= — E-VERIFY V0-S1/S2: done 항목의 근거 리스트(Lv2 펼침 전용). */
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/evidence');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

/** story #2258 — 증거연결: BE는 이미 있었는데 FE가 부르지 않던 경로.
 * 긴급 정정(2026-07-28, prod 크래시): BE create_evidence는 단건 객체를 그대로 반환하는데
 * (list 아님, response_model=EvidenceResponse) apiSuccess로 한 번 더 감싸 소비부(evidence-
 * section.tsx)가 실제로는 {data,error,meta}를 받으면서 `as EvidenceItem`으로 거짓 단언했다.
 * 형제(request-verification route)처럼 그대로 돌려준다 — raw passthrough, 새 규칙 발명 0. */
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    return await proxyToFastapi(request, '/api/v2/evidence');
  } catch (err: unknown) { return handleApiError(err); }
}
