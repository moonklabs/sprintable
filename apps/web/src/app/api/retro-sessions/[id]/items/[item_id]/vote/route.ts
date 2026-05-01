import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { RetroSessionService } from '@/services/retro-session';
import { isOssMode } from '@/lib/storage/factory';
import { voteOssRetroItem } from '@/lib/oss-retro';

type RouteParams = { params: Promise<{ id: string; item_id: string }> };

// POST /api/retro-sessions/:id/items/:item_id/vote
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { item_id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const body = await request.json().catch(() => ({})) as { voter_id?: string };
    const voterId = body.voter_id ?? me.id;

    if (isOssMode()) {
      const data = await voteOssRetroItem(item_id, voterId, projectId);
      return apiSuccess(data);
    }

    const dbClient = undefined;
    const service = new RetroSessionService(dbClient);
    const data = await service.voteItem(item_id, voterId, projectId);
    return apiSuccess(data);
  } catch (err: unknown) {
    const e = err as Error & { code?: string };
    if (e.code === 'CONFLICT') return apiError('CONFLICT', e.message, 409);
    return handleApiError(err);
  }
}
