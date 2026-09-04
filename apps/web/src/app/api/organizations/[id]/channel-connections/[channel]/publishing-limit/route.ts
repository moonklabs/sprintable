import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; channel: string }> };

// story #3402(Phase1·마케팅운영, AC7) — 발행 한도 잔량(UI 표시용). 백엔드
// backend/app/routers/channel_connections.py::get_channel_publishing_limit(story #f8f7cb0f)
// 그대로 위임 — 휴먼 전용(서버 `_require_human()` 가드), 검증 로직 0.
//
// ⚠️disconnect/test/route.ts와 동일 이유로 폴더명은 `[channel]`이지만 실제 값은
// connection_id(UUID)다(Next.js 동일 깊이 슬러그명 통일 제약, PO 실측 실사고).
export async function GET(request: Request, { params }: RouteParams) {
  const { id, channel: connectionId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/publishing-limit', { id, connectionId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
