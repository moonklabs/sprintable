
import { NextResponse } from 'next/server';

import { parseBody, updateStorySchema } from '@sprintable/shared';

import { StoryService } from '@/services/story';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createStoryRepository } from '@/lib/storage/factory';
import { NotificationService } from '@/services/notification.service';

// story #2315 AC1: BE(`references{stored, dropped[]}`)의 형제 필드 — `parseDroppedReferences`
// (reference-drop-notice.tsx, 채팅과 story 양쪽이 공유)가 top-level `references`를 읽는다.
// apiSuccess()의 `{data, error, meta}` 삼종(정책 7.3)엔 그 자리가 없어, 이 라우트만 별도로
// 조립한다 — meta에 얹지 않는 이유: parseDroppedReferences가 이미 다른 표면(채팅의 raw
// backend 응답)에서 top-level만 보도록 고정돼 있어, 여기서만 meta로 옮기면 두 표면이 같은
// 파서를 쓰면서 자리가 갈리는 쌍둥이 갭이 된다.
//
// ⛔정책 7.3(`{data, error, meta}` 삼종) 의도적 예외 — 이 PATCH 핸들러만. 위반이 아니라
// FE 계약(top-level `references`, #2614)을 지키기 위한 선택이다. `data` 안에 넣지 않는
// 이유: `references`가 story 필드가 아닌데 거기 섞이면 `KanbanStory` 타입이 오염된다.
// 다음 사람이 "왜 여기만 정책을 안 지키나"로 읽지 않도록 — 실제 조립부는 아래 `if
// (references)` 블록, 근거는 이 주석.
interface StoryReferencesSideband {
  stored: number;
  dropped: Array<{ target_type: string; target_id: string; reason?: string }>;
}

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    const repo = await createStoryRepository();
    const service = new StoryService(repo, dbClient);
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
    const dbClient = undefined;

    const parsed = await parseBody(request, updateStorySchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createStoryRepository();
    const service = new StoryService(repo, dbClient, { isAdminContext: me.type === 'agent' });

    const before = await service.getById(id);
    // BE(#2315 AC1)가 description·acceptance_criteria 저장 시에만 `references`를 story
    // 객체의 형제 키로 싣는다(정상 경로엔 없음 — 채팅과 동일 게이트). 여기서 떼어내 응답
    // 최상위로 옮긴다 — data 안에 남기면 KanbanStory가 아닌 필드가 섞여 든다.
    const storyRaw = (await service.update(id, body)) as typeof before & { references?: StoryReferencesSideband };
    const { references, ...story } = storyRaw;

    const actorId = me.id;
    const orgId = me.org_id;

    // 담당자 변경 알림 + activity log
    if ('assignee_id' in body && body.assignee_id !== before.assignee_id) {
      const newAssigneeId = body.assignee_id as string | null;
      const oldAssigneeId = before.assignee_id as string | null;

      if (dbClient) {
        const notifService = new NotificationService(dbClient);
        if (newAssigneeId && newAssigneeId !== actorId) {
          notifService.create({ org_id: orgId, user_id: newAssigneeId, type: 'story_assigned', title: '스토리가 배정되었습니다', body: before.title ?? '', reference_type: 'story', reference_id: id }).catch(() => {});
        }
        if (oldAssigneeId && oldAssigneeId !== actorId && oldAssigneeId !== newAssigneeId) {
          notifService.create({ org_id: orgId, user_id: oldAssigneeId, type: 'story_assigned', title: '스토리 담당자가 변경되었습니다', body: before.title ?? '', reference_type: 'story', reference_id: id }).catch(() => {});
        }
      }

      service.logActivity({ story_id: id, org_id: orgId, actor_id: actorId, action_type: 'assignee_changed', old_value: oldAssigneeId, new_value: newAssigneeId }).catch(() => {});
    }

    // 상태 변경 activity log
    if (body.status && body.status !== before.status) {
      service.logActivity({ story_id: id, org_id: orgId, actor_id: actorId, action_type: 'status_changed', old_value: before.status as string, new_value: body.status }).catch(() => {});
    }

    // 제목 변경 activity log
    if (body.title && body.title !== before.title) {
      service.logActivity({ story_id: id, org_id: orgId, actor_id: actorId, action_type: 'title_changed', old_value: before.title ?? null, new_value: body.title }).catch(() => {});
    }

    if (references) {
      return NextResponse.json({ data: story, error: null, meta: null, references });
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
    const dbClient = undefined;

    const repo = await createStoryRepository();
    const service = new StoryService(repo, dbClient);
    await service.delete(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
