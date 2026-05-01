import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { apiSuccess } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/api-keys/[id]/logs — 키별 사용 이력 (admin/owner only) */
export async function GET(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiSuccess([]);
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/api-keys/${id}/logs`);
}
