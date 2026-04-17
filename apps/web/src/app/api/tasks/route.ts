import { parseBody, createTaskSchema } from '@sprintable/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { TaskService, type CreateTaskInput } from '@/services/task';
import { createTaskRepository } from '@/lib/storage/factory';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const { searchParams } = new URL(request.url);
    const storyId = searchParams.get('story_id') ?? undefined;
    const projectId = searchParams.get('project_id') ?? undefined;
    const assigneeId = searchParams.get('assignee_id') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const statusNe = searchParams.get('status_ne') ?? undefined;
    const daysSince = searchParams.get('days_since') ? Number(searchParams.get('days_since')) : undefined;
    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: searchParams.get('cursor'),
    }, { defaultLimit: 50, maxLimit: 100 });

    const repo = await createTaskRepository(dbClient);
    const service = new TaskService(repo);
    const tasks = await service.list({
      story_id: storyId,
      project_id: projectId,
      assignee_id: assigneeId,
      status,
      status_ne: statusNe,
      days_since: daysSince,
      limit: pageInput.limit,
      cursor: pageInput.cursor,
    });
    const { page, meta } = buildCursorPageMeta(tasks, pageInput.limit, 'created_at');

    if (!storyId) {
      return apiSuccess(page, meta);
    }

    const [totalResult, doneResult] = await Promise.all([
      dbClient.from('tasks').select('id', { count: 'exact', head: true }).eq('story_id', storyId),
      dbClient.from('tasks').select('id', { count: 'exact', head: true }).eq('story_id', storyId).eq('status', 'done'),
    ]);

    if (totalResult.error) throw totalResult.error;
    if (doneResult.error) throw doneResult.error;

    return apiSuccess(page, {
      ...meta,
      totalCount: totalResult.count ?? page.length,
      doneCount: doneResult.count ?? (page as Array<{ status: string }>).filter((t) => t.status === 'done').length,
    });
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient: SupabaseClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const parsed = await parseBody(request, createTaskSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createTaskRepository(dbClient);
    const service = new TaskService(repo);
    const task = await service.create(body as CreateTaskInput);
    return apiSuccess(task, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
