import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { SprintService, type CreateSprintInput } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { parseBody, createSprintSchema } from '@sprintable/shared';

// POST /api/sprints — 생성
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const parsed = await parseBody(request, createSprintSchema);
    if (!parsed.success) return parsed.response;
    const service = new SprintService(dbClient);
    const sprint = await service.create(parsed.data as CreateSprintInput);
    return apiSuccess(sprint, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// GET /api/sprints — 목록
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const { searchParams } = new URL(request.url);
    const service = new SprintService(dbClient);
    const sprints = await service.list({
      project_id: searchParams.get('project_id') ?? undefined,
      status: searchParams.get('status') ?? undefined,
    });
    return apiSuccess(sprints);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
