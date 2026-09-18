import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3376(Phase1·마케팅운영), doc phase1-channel-connect-fe-grounding §10-3 — 목록
// 그대로 pass-through(member 이상, BE가 인가 판정·토큰 필드는 응답 DTO에 아예 없다).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/channel-connections', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
