import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story e4fc29fa(조각⑤, BE #3802 착지) — webhook 연결 생성(owner/admin 휴먼 세션
// 전용, BE `_require_owner_or_admin`). channel-connections/sandbox/route.ts·wordpress/
// route.ts와 동형 — FE에 대응 BFF가 없어 브라우저에서 만들 길이 없던 갭(PO 실측
// 404). 검증 로직 0, body(target_url/secret) pass-through 그대로,
// CHANNEL_CONNECTION_HUMAN_ONLY(403)·CHANNEL_CONNECTION_DESTINATION_INSECURE(422)·
// WEBHOOK_FIELDS_REQUIRED(422)·401 전부 서버 응답 그대로 pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/webhook', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
