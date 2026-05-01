import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { setupInboxRoute, mapInboxRepoError } from '@/lib/inbox-route-helpers';
import { createInboxItemRepository } from '@/lib/storage/factory';
import { parseBody, resolveInboxItemSchema } from '@sprintable/shared';

/** POST /api/inbox/:id/resolve — 의사결정 처리 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return ApiErrors.badRequest('id required');

    const setup = await setupInboxRoute(request);
    if (!setup.ok) return setup.response;
    const { me, dbClient } = setup;

    const parsed = await parseBody(request, resolveInboxItemSchema);
    if (!parsed.success) return parsed.response;

    const repo = await createInboxItemRepository();
    try {
      const result = await repo.resolve(id, me.org_id, {
        resolved_by: me.id,
        resolved_option_id: parsed.data.choice,
        resolved_note: parsed.data.note ?? null,
      });
      return apiSuccess(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('Option id') || msg.includes('option_id')) return ApiErrors.badRequest(msg);
      return mapInboxRepoError(err);
    }
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
