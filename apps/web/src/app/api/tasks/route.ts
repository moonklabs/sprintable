
import { parseBody, createTaskSchema } from '@sprintable/shared';
import { createAdminClient } from '@/lib/db/admin';
import { TaskService, type CreateTaskInput } from '@/services/task';
import { createTaskRepository, isOssMode } from '@/lib/storage/factory';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';

async function getStoryTaskCounts(
  service: TaskService,
  storyId: string,
  dbClient: any | undefined,
  ossMode: boolean,
) {
  if (ossMode || !dbClient) {
    const [allTasks, doneTasks] = await Promise.all([
      service.list({ story_id: storyId }),
      service.list({ story_id: storyId, status: 'done' }),
    ]);

    return {
      totalCount: allTasks.length,
      doneCount: doneTasks.length,
    };
  }

  const [totalResult, doneResult] = await Promise.all([
    dbClient.from('tasks').select('id', { count: 'exact', head: true }).eq('story_id', storyId),
    dbClient.from('tasks').select('id', { count: 'exact', head: true }).eq('story_id', storyId).eq('status', 'done'),
  ]);

  if (totalResult.error) throw totalResult.error;
  if (doneResult.error) throw doneResult.error;

  return {
    totalCount: totalResult.count,
    doneCount: doneResult.count,
  };
}

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient: any | undefined = ossMode ? undefined : (me.type === 'agent' ? createAdminClient() : undefined);

    const { searchParams } = new URL(request.url);
    const storyId = searchParams.get('story_id') ?? undefined;
    const storyIdsRaw = searchParams.get('story_ids');
    const storyIds = storyIdsRaw ? storyIdsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
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

    // story_ids: 일괄 조회 (kanban board N+1 방지용)
    if (storyIds && storyIds.length > 0) {
      if (dbClient) {
        let q = dbClient.from('tasks').select('*').in('story_id', storyIds).order('created_at', { ascending: true });
        if (status) q = q.eq('status', status);
        const { data, error } = await q;
        if (error) throw error;
        return apiSuccess(data ?? []);
      }
      // OSS: fallback to per-story serial fetch
      const all: unknown[] = [];
      for (const sid of storyIds) {
        const items = await service.list({ story_id: sid, status });
        all.push(...items);
      }
      return apiSuccess(all);
    }

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

    const counts = await getStoryTaskCounts(service, storyId, dbClient, ossMode);

    return apiSuccess(page, {
      ...meta,
      totalCount: counts.totalCount ?? page.length,
      doneCount: counts.doneCount ?? (page as Array<{ status: string }>).filter((t) => t.status === 'done').length,
    });
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient: any = me.type === 'agent' ? createAdminClient() : undefined;

    const parsed = await parseBody(request, createTaskSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createTaskRepository(dbClient);
    const service = new TaskService(repo);
    const task = await service.create(body as CreateTaskInput);
    return apiSuccess(task, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
