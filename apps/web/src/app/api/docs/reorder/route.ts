import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { ApiErrors } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4353 — 문서 하나를 부모 아래 형제 순서의 한 자리로(`{doc_id, parent_id, after_id?}`). 형제 번호 다시 매기기 · 409 · 404는
// 서버가 판정하고, 이 경로는 그 응답을 그대로 돌려준다(끌기 재정렬 · 폴더로 옮기기 · 키보드 옮기기가 같은 길).
export async function POST(request: Request) {
  const me = await getOrgProjectAuthContext(request);
  if (!me) return ApiErrors.unauthorized();
  if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
  return proxyToFastapi(request, '/api/v2/docs/reorder');
}
