
import { parseBody, updateStorySchema } from '@sprintable/shared';
import { createAdminClient } from '@/lib/db/admin';
import { StoryService } from '@/services/story';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createStoryRepository } from '@/lib/storage/factory';
import { NotificationService } from '@/services/notification.service';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createAdminClient() : undefined);

    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient as any | undefined);
    const story = await service.getByIdWithDetails(id);

    // Agent scope 검증: cross-project 접근 차단
    if (me.type === 'agent' && story.project_id !== me.project_id) {
      return ApiErrors.forbidden('Forbidden: cross-project access not allowed');
    }

    return apiSuccess(story);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createAdminClient() : undefined);

    const parsed = await parseBody(request, updateStorySchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient as any | undefined, { isAdminContext: me.type === 'agent' });

    const before = await service.getById(id);
    const story = await service.update(id, body);

    if (!ossMode && dbClient) {
      const notifService = new NotificationService(dbClient as any);
      const actorId = me.id;
      const orgId = me.org_id;

      // 담당자 변경 알림 + activity log (AC1, AC5)
      if ('assignee_id' in body && body.assignee_id !== before.assignee_id) {
        const newAssigneeId = body.assignee_id as string | null;
        const oldAssigneeId = before.assignee_id as string | null;

        if (newAssigneeId && newAssigneeId !== actorId) {
          notifService.create({ org_id: orgId, user_id: newAssigneeId, type: 'story_assigned', title: '스토리가 배정되었습니다', body: before.title ?? '', reference_type: 'story', reference_id: id }).catch(() => {});
        }
        if (oldAssigneeId && oldAssigneeId !== actorId && oldAssigneeId !== newAssigneeId) {
          notifService.create({ org_id: orgId, user_id: oldAssigneeId, type: 'story_assigned', title: '스토리 담당자가 변경되었습니다', body: before.title ?? '', reference_type: 'story', reference_id: id }).catch(() => {});
        }

        service.logActivity({ story_id: id, org_id: orgId, actor_id: actorId, action_type: 'assignee_changed', old_value: oldAssigneeId, new_value: newAssigneeId }).catch(() => {});
      }

      // 상태 변경 activity log (AC4)
      if (body.status && body.status !== before.status) {
        service.logActivity({ story_id: id, org_id: orgId, actor_id: actorId, action_type: 'status_changed', old_value: before.status as string, new_value: body.status }).catch(() => {});
      }
    }

    return apiSuccess(story);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createAdminClient() : undefined);

    const repo = await createStoryRepository(dbClient);
    const service = new StoryService(repo, dbClient as any | undefined);
    await service.delete(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
