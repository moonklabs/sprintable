import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story 5b27b32f AC2(BE #3430, PR #3779) — 샌드박스 채널 연결 생성(owner/admin 휴먼
// 세션 전용, BE `_require_owner_or_admin`). FE에 대응 BFF가 없어(story #3419
// cancel-scheduled/unpublish 선례와 달리 이 엔드포인트만 배선이 빠져) 배포19 서빙 뒤
// 브라우저에서 만들 길이 없던 갭 — 검증 로직 0, CHANNEL_CONNECTION_HUMAN_ONLY(403)·
// CHANNEL_CONNECTION_OWNER_OR_ADMIN_ONLY(403)·CHANNEL_SANDBOX_DISABLED(404, 어댑터
// 미등재 — prod/미설정 dev)·401 전부 서버 응답 그대로 pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/sandbox', { id },
  );
  if (!_r.ok) return _r;
  // 백엔드가 201로 신규 연결 생성을 알린다(channel-posts/drafts/route.ts와 동일 이유).
  return apiSuccess(await _r.json(), undefined, _r.status);
}
