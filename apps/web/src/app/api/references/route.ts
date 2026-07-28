import { handleApiError } from '@/lib/api-error';
import { ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * POST /api/references — story #2283/#2582(디디군, PO 확定 계약): 사람이 확인한 참조를
 * 즉시 반영하는 쓰기 경로. raw passthrough(새 규칙 발명 0) — ⛔BE가 신규 201 / 기존 200을
 * 일부러 구별해 돌려주므로(멱등) 이 프록시가 apiSuccess()로 재감싸면 상태코드가 200으로
 * 뭉개진다(오늘 형제 비대칭 클래스 재발). 그래서 evidence/route.ts POST와 동일하게
 * 상태코드까지 그대로 흘려보낸다.
 */
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    return await proxyToFastapi(request, '/api/v2/references');
  } catch (err: unknown) { return handleApiError(err); }
}
