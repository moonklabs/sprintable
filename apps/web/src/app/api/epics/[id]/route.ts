import { updateEpicSchema } from '@sprintable/shared';

import { EpicService } from '@/services/epic';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createEpicRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const repo = await createEpicRepository();
    const service = new EpicService(repo);
    return apiSuccess(await service.getByIdWithStories(id, { org_id: me.org_id, project_id: me.project_id }));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    let rawBody: unknown;
    try { rawBody = await request.json(); } catch { return apiError('BAD_REQUEST', 'Invalid JSON body', 400); }
    if (!rawBody || typeof rawBody !== 'object') return apiError('BAD_REQUEST', 'Body must be an object', 400);
    const parsed = updateEpicSchema.safeParse(rawBody);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);

    const repo = await createEpicRepository();
    const service = new EpicService(repo);
    try {
      return apiSuccess(await service.update(id, parsed.data, { org_id: me.org_id, project_id: me.project_id }));
    } catch (e: unknown) {
      const err = e as Error & { code?: string };
      if (err.code === 'INVALID_TRANSITION') return apiError('BAD_REQUEST', err.message, 400);
      throw e;
    }
  } catch (err: unknown) { return handleApiError(err); }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    // authz(admin/owner) 는 BE delete_epic 가 SSOT. FE 의 requireRole 게이트는 Supabase
    // 레거시(db=undefined) 의존으로 깨져 있었고, 제거 시 BE 게이트 부재면 권한 누수였으므로
    // BE 에 authz 를 신설한 뒤 thin proxy 로 전환한다.
    const repo = await createEpicRepository();
    const service = new EpicService(repo);
    await service.delete(id, me.org_id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) { return handleApiError(err); }
}
