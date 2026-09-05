import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3540(Phase1·마케팅운영, 페드루 PO 確定 2026-09-06) — 「성과 수집」 섹션 상태
// 그대로 pass-through(org 멤버 이상, 이 응답엔 토큰류 필드가 아예 없다).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/measurement-connections', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
