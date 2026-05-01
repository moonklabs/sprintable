import { parseBody, updateTaskSchema } from '@sprintable/shared';
import { TaskService } from '@/services/task';
import { createTaskRepository, isOssMode } from '@/lib/storage/factory';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { NotificationService } from '@/services/notification.service';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const repo = await createTaskRepository();
    const service = new TaskService(repo);
    return apiSuccess(await service.getById(id, { org_id: me.org_id, project_id: me.project_id }));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const parsed = await parseBody(request, updateTaskSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createTaskRepository();
    const service = new TaskService(repo);
    const before = await service.getById(id, { org_id: me.org_id, project_id: me.project_id });
    const result = await service.update(id, body);

    if (!isOssMode()) {
      const notifService = new NotificationService(dbClient);
      if (body.assignee_id && body.assignee_id !== before.assignee_id) {
        notifService.create({
          org_id: me.org_id,
          user_id: body.assignee_id,
          type: 'task_assigned',
          title: '태스크가 배정되었습니다',
          body: before.title ?? '',
          reference_type: 'task',
          reference_id: id,
        }).catch(() => {});
      }
      if (body.status === 'done' && before.status !== 'done' && before.story_id) {
        (async () => {
          const { data } = await dbClient.from('stories').select('assignee_id').eq('id', before.story_id).maybeSingle();
          if (data?.assignee_id) {
            await notifService.create({
              org_id: me.org_id,
              user_id: data.assignee_id as string,
              type: 'task_completed',
              title: '태스크가 완료되었습니다',
              body: before.title ?? '',
              reference_type: 'task',
              reference_id: id,
            });
          }
        })().catch(() => {});
      }
    }

    return apiSuccess(result);
  } catch (err: unknown) { return handleApiError(err); }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;
    const repo = await createTaskRepository();
    const service = new TaskService(repo);
    const existing = await service.getById(id, { org_id: me.org_id });
    await service.delete(id, existing.org_id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
