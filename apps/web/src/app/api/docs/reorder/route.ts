import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { ApiErrors, apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4353 — 문서 하나를 부모 아래 형제 순서의 한 자리로(`{doc_id, parent_id, after_id?}`). 형제 번호 다시 매기기 · 409 · 404는
// 서버가 판정하고, 이 경로는 그 응답을 그대로 돌려준다(끌기 재정렬 · 폴더로 옮기기 · 키보드 옮기기가 같은 길).
export async function POST(request: Request) {
  const me = await getOrgProjectAuthContext(request);
  if (!me) return ApiErrors.unauthorized();
  if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
  // 까디르(4736 P2) — 백엔드는 성공을 봉투 없이 `{doc, siblings}`로 준다. 화면(placeDoc)은 이 저장소 관례대로 `json.data`를 읽으므로
  // 여기서 `{data}`로 감싼다(proxyToFastapiWrapped와 같은 규칙 · 오류 봉투는 그대로 통과). 감싸기를 이 경로 안에 두어 테스트가 실제
  // 백엔드 모양으로 목을 줘도 감싸기까지 잰다.
  const res = await proxyToFastapi(request, '/api/v2/docs/reorder');
  if (!res.ok || res.status === 204) return res;
  return apiSuccess(await res.json());
}
