import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; channel: string }> };

// story #3815(Phase3·3-5 PR4, 페드루 PO 決定①·2026-09-12) — YouTube API 일일
// 단위 사용량(플랫폼 공유 축·연결은 인가만, publishing-limit의 연결별/조직별
// 발행 횟수 한도와는 다른 축). 백엔드 계약(디디 PR3, #4225 착지분):
// GET /api/v2/organizations/{org}/channel-connections/{connection_id}/youtube-usage
// → {used_units, limit_units, remaining_units, reset_at, scope:"platform"}.
//
// ⚠️publishing-limit/route.ts와 동일 이유로 폴더명은 `[channel]`이지만 실제
// 값은 connection_id(UUID)다(Next.js 동일 깊이 슬러그명 통일 제약).
export async function GET(request: Request, { params }: RouteParams) {
  const { id, channel: connectionId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/youtube-usage', { id, connectionId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
