import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; connectorId: string }> };

// story #4166 — revoke/route.ts와 동형(owner/admin 휴먼 세션, BE가 인가 판정).
// 검증 로직 0, BE 응답(200·403·404·409·422) 그대로 pass-through. PATCH만 다룬다 —
// 이 엔드포인트의 스코프가 리전 변경 1개뿐이라(BE GenerationConnectorLocationPatchRequest),
// 다른 메서드는 애초에 라우트에 없다.
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id, connectorId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/generation-connectors/[connectorId]', { id, connectorId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
