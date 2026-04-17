import { createEpicSchema } from '@sprintable/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { EpicService, type CreateEpicInput } from '@/services/epic';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';
import { createEpicRepository } from '@/lib/storage/factory';

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const { searchParams } = new URL(request.url);
    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: searchParams.get('cursor'),
    }, { defaultLimit: 50, maxLimit: 100 });
    const repo = await createEpicRepository(dbClient);
    const service = new EpicService(repo);
    const epics = await service.list({
      project_id: searchParams.get('project_id') ?? undefined,
      limit: pageInput.limit,
      cursor: pageInput.cursor,
    });
    const { page, meta } = buildCursorPageMeta(epics, pageInput.limit, 'created_at');
    return apiSuccess(page, meta);
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return apiError('BAD_REQUEST', 'Invalid JSON body', 400);
    }
    if (!rawBody || typeof rawBody !== 'object') {
      return apiError('BAD_REQUEST', 'Body must be an object', 400);
    }
    const body = rawBody as Record<string, unknown>;
    if (!body.project_id) body.project_id = me.project_id;
    if (!body.org_id) body.org_id = me.org_id;
    const parsed = createEpicSchema.safeParse(body);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    const repo = await createEpicRepository(dbClient);
    const service = new EpicService(repo);
    const epic = await service.create(parsed.data as unknown as CreateEpicInput);
    return apiSuccess(epic, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
