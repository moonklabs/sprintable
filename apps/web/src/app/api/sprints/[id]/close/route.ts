

import { SprintService } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createSprintRepository, createDocRepository } from '@/lib/storage/factory';
import { NotificationService } from '@/services/notification.service';
import { DocsService } from '@/services/docs';
import { requireRole, EDIT_ROLES } from '@/lib/role-guard';

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/sprints/:id/close — active→closed + velocity 자동 계산
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    if (dbClient && me.type !== 'agent') {
      const denied = await requireRole(dbClient, me.org_id, EDIT_ROLES, 'Admin or PO access required to close sprint');
      if (denied) return denied;
    }

    const repo = await createSprintRepository(dbClient);
    const service = new SprintService(repo, dbClient as any | undefined);
    const sprint = await service.close(id);

    return apiSuccess(sprint);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
