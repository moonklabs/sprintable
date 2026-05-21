import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; memberId: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  const { id, memberId } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/members/[memberId]', { id, memberId });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { id, memberId } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/organizations/[id]/members/[memberId]', { id, memberId });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
