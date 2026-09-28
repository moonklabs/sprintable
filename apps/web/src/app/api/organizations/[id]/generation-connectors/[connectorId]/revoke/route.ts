import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; connectorId: string }> };

// story #4101 CHANGES-2(페드루 PO 리뷰, 2026-09-21) — channel-connections/[channel]/
// disconnect/route.ts와 동형(owner/admin 휴먼 세션, BE가 인가 판정). 검증 로직 0,
// BE 응답(200·403·404) 그대로 pass-through.
export async function POST(request: Request, { params }: RouteParams) {
  const { id, connectorId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/generation-connectors/[connectorId]/revoke', { id, connectorId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
