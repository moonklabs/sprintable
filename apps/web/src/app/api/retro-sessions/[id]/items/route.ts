import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { addOssRetroItem } from '@/lib/oss-retro';
import type { RetroCategory } from '@/lib/oss-retro';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/retro-sessions/:id/items?project_id=X
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    return proxyToFastapiWithParams(request, '/api/v2/retros/[id]/items', { id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// POST /api/retro-sessions/:id/items
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    if (isOssMode()) {
      const { searchParams } = new URL(request.url);
      const projectId = searchParams.get('project_id');
      if (!projectId) return ApiErrors.badRequest('project_id required');
      const body = await request.json() as { category?: string; text?: string; author_id?: string };
      if (!body.category) return ApiErrors.badRequest('category required');
      if (!body.text) return ApiErrors.badRequest('text required');
      const data = await addOssRetroItem({ session_id: id, project_id: projectId, category: body.category as RetroCategory, text: body.text, author_id: body.author_id ?? me.id });
      return apiSuccess(data);
    }

    return proxyToFastapiWithParams(request, '/api/v2/retros/[id]/items', { id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
