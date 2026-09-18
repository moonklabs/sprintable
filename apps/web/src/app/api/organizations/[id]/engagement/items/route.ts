import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3805(Phase3·3-1·PR 2[FE]) — publications/[publicationId]/comments/route.ts와
// 동형 미러(재발명 0). status/channel/cursor/limit querystring은 원 요청 그대로 얹어
// 보낸다(BE가 limit/offset이 아니라 cursor 계약 — 08:14Z 낱말 정정으로 engagement/*).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/engagement/items', { id },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
