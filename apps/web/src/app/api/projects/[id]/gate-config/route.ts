import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * HITL 게이트 레벨 config 프록시 (S-GATE-4). BE `GET/PUT /api/v2/projects/{id}/gate-config`.
 * GET = effective 레벨+source 목록 / PUT = 셀 1개 설정 (`{scope,work_type,actor_type,level}`) /
 * DELETE = project override 해제(`?work_type=&actor_type=` → 상속 복귀). 권한·안전하한은 BE 강제.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/projects/[id]/gate-config', { id });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess([]);
  return apiSuccess(await _r.json());
}

export async function PUT(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/projects/[id]/gate-config', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}

// DELETE — project override 해제(↺ 기본값). query `?work_type=&actor_type=` 는 proxyToFastapi 가
// url.search 로 보존 전달. 응답 = 삭제 후 effective 레벨+source(상속).
export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/projects/[id]/gate-config', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
