import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; recordId: string }> };

export async function DELETE(request: Request, { params }: RouteParams) {
  const { id, recordId } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/projects/[id]/access/[recordId]', { id, recordId });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
