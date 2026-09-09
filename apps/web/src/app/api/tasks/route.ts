import type { DbClient } from '@/services/db-client';
import { parseBody, createTaskSchema } from '@sprintable/shared';

import { TaskService, type CreateTaskInput } from '@/services/task';
import { createTaskRepository } from '@/lib/storage/factory';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';

async function getStoryTaskCounts(
  service: TaskService,
  storyId: string,
  dbClient: DbClient | undefined,
) {
  if (!dbClient) {
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
    const dbClient = undefined as DbClient | undefined;

    const { searchParams } = new URL(request.url);
    // story #2262 PR②(BE #2905) — ids는 task 자신의 id로 배치 lookup(story ca37b2b0과
    // 동일 계약). ⛔story_ids(아래, 부모 story로 묶어 자식 task들을 찾는 기존 기능)와
    // 다른 축이다 — 이건 "이 id들 자체가 task다"라는 뜻.
    const IDS_BATCH_CAP = 200;
    const idsParam = searchParams.get('ids');
    const parsedIds = idsParam ? idsParam.split(',').map((id) => id.trim()).filter(Boolean).slice(0, IDS_BATCH_CAP) : [];
    if (parsedIds.length > 0) {
      const repo = await createTaskRepository();
      const service = new TaskService(repo);
      const tasks = await service.list({ ids: parsedIds, limit: parsedIds.length });
      return apiSuccess(tasks);
    }

    const storyId = searchParams.get('story_id') ?? undefined;
    const storyIdsRaw = searchParams.get('story_ids');
    const storyIds = storyIdsRaw ? storyIdsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const projectId = searchParams.get('project_id') ?? undefined;
    const assigneeId = searchParams.get('assignee_id') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const statusNe = searchParams.get('status_ne') ?? undefined;
    // story #3713 후속(페드루 PO CHANGES, 2026-09-09) — days_since는 BE tasks 라우터에
    // 대응 Query 파라미터가 없어(project_id·status_ne·ids·limit·cursor만 받음) FastAPI가
    // 조용히 버렸다 — 이 스토리가 막으려는 바로 그 클래스(«경계 넘는 이름이 양쪽 다르면
    // 조용히 버려진다»)를 FE→BE 경계에서 재현하고 있었다. 실사용처도 0(어떤 FE 화면도
    // 이 파라미터를 실제로 안 씀)이라 forwarding으로 «완전성»을 흉내내는 대신 끝단까지
    // 은퇴한다(TaskListFilters/TASK_LIST_FILTER_KEYS에서도 같이 제거).
    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: searchParams.get('cursor'),
    }, { defaultLimit: 50, maxLimit: 100 });

    const repo = await createTaskRepository();
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
      limit: pageInput.limit,
      cursor: pageInput.cursor,
    });
    const { page, meta } = buildCursorPageMeta(tasks, pageInput.limit, 'created_at');

    if (!storyId) {
      return apiSuccess(page, meta);
    }

    const counts = await getStoryTaskCounts(service, storyId, dbClient);

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
    const parsed = await parseBody(request, createTaskSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createTaskRepository();
    const service = new TaskService(repo);
    const task = await service.create(body as CreateTaskInput);
    return apiSuccess(task, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
