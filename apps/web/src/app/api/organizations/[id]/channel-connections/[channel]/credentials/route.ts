import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; channel: string }> };

// story #3492 — 붙여넣기(pasted_secret) 자격 「제자리 교체」. disconnect/route.ts와 동형
// 이유로 폴더명은 `[channel]`이지만 실제 값은 connection_id(UUID) — 형제 동적 세그먼트
// 슬러그 이름 통일 제약(Next.js) 그대로.
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id, channel: connectionId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/credentials', { id, connectionId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
