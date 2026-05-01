// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { SprintService } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createSprintRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/sprints/:id/activate — planning→active
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : undefined);

    const repo = await createSprintRepository(dbClient);
    const service = new SprintService(repo, dbClient as SupabaseClient | undefined);
    const sprint = await service.activate(id);
    return apiSuccess(sprint);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
