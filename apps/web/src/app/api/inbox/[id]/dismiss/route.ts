import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { setupInboxRoute, mapInboxRepoError } from '@/lib/inbox-route-helpers';
import { createInboxItemRepository } from '@/lib/storage/factory';
import { parseBody, dismissInboxItemSchema } from '@sprintable/shared';

/** POST /api/inbox/:id/dismiss — 항목 dismiss (사용자가 무시) */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return ApiErrors.badRequest('id required');

    const setup = await setupInboxRoute(request);
    if (!setup.ok) return setup.response;
    const { me, dbClient } = setup;

    const parsed = await parseBody(request, dismissInboxItemSchema);
    if (!parsed.success) return parsed.response;

    const repo = await createInboxItemRepository();
    try {
      const result = await repo.dismiss(id, me.org_id, {
        resolved_by: me.id,
        resolved_note: parsed.data.reason ?? null,
      });
      return apiSuccess(result);
    } catch (err: unknown) {
      return mapInboxRepoError(err);
    }
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
