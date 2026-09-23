import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * story #3953 「외부 발행 일시 중지」 프록시. BE `GET/PUT
 * /api/v2/organizations/{org_id}/external-publish-pause` — 이 BFF 라우트가 누락돼
 * `ExternalPublishPauseCard`(external-publish-pause-card.tsx)의 GET이 항상 404였다
 * (PR #4363 후속 CHANGES, 페드루 PO 실측). GET = member 이상 열람 / PUT = owner만
 * (admin·에이전트 키 403, BE 강제).
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/external-publish-pause', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}

export async function PUT(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/external-publish-pause', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
