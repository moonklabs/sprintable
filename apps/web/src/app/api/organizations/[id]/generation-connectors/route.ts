import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #4101 — 목록 그대로 pass-through(org admin 이상, BE가 인가 판정·credentials
// 필드는 응답 DTO에 아예 없다). channel-connections/route.ts와 동형(story #3376).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/generation-connectors', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
