import { apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Not available in OSS mode.', 501);
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/hitl/requests/${id}`);
}
