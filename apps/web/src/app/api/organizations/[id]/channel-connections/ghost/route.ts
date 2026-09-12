import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3816(Phase3·3-6 PR1, 페드루 PO 確定 2026-09-12) — Ghost 연결 생성
// (owner/admin 휴먼 세션 전용, BE `_require_owner_or_admin`). channel-connections/
// wordpress/route.ts·stibee/route.ts와 동형 — 이 폴더가 채널마다 리터럴 파일이라
// FE PASTED_SECRET_FIELDS에 ghost를 등재해도 이 BFF가 없으면 브라우저에서 만들
// 길이 없다(그 형제들 docstring이 이미 경고한 결함 클래스, verify-pasted-secret-
// bff-route-registered.ts 가드가 이 파일 누락을 잡는다). 검증 로직 0, body
// (site_url/admin_api_key) pass-through 그대로, CHANNEL_CONNECTION_HUMAN_ONLY(403)·
// GHOST_FIELDS_REQUIRED(422)·GHOST_ADMIN_KEY_INVALID(422)·401 전부 서버 응답
// 그대로 pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/ghost', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
