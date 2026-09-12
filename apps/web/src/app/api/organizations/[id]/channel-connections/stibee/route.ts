import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3813(Phase3·3-4 PR5-a, 페드루 PO 確定 2026-09-12) — Stibee 연결 생성
// (owner/admin 휴먼 세션 전용, BE `_require_owner_or_admin`). channel-connections/
// wordpress/route.ts·webhook/route.ts와 동형 — 이 폴더가 채널마다 리터럴 파일이라
// FE PASTED_SECRET_FIELDS에 stibee를 등재해도 이 BFF가 없으면 브라우저에서 만들
// 길이 없다(실측 404, 그 형제들 docstring이 이미 경고한 같은 결함 클래스가 세
// 번째로 재발). 검증 로직 0, body(api_key/list_id) pass-through 그대로,
// CHANNEL_CONNECTION_HUMAN_ONLY(403)·STIBEE_FIELDS_REQUIRED(422)·
// STIBEE_API_KEY_INVALID(422)·401 전부 서버 응답 그대로 pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/stibee', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
