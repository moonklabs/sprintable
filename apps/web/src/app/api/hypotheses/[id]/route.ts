import { updateHypothesisSchema } from '@sprintable/shared';
import { HypothesisService } from '@/services/hypothesis';
import { createHypothesisRepository } from '@/lib/storage/factory';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

type RouteParams = { params: Promise<{ id: string }> };

// GET — single hypothesis by id (E-LOOP-LEDGER S6: loop 상세 goal statement 표시용 —
// LoopResponse엔 hypothesis_id만 있어 FE가 별도 조회, handoff §4-1 갭 해소).
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const service = new HypothesisService(await createHypothesisRepository());
    const hypothesis = await service.getById(id);
    return apiSuccess(hypothesis);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PATCH — general update + the "confirm draft" path (draft_metadata.confirmed=true).
// Confirm draft is intentionally NOT a status transition (PO §12.2): it's a lightweight
// PATCH that records the user's edits + confirmed flag, removing the "draft" pin.
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const parsed = updateHypothesisSchema.safeParse(await request.json());
    if (!parsed.success) return ApiErrors.badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');

    const service = new HypothesisService(await createHypothesisRepository());
    const updated = await service.update(id, parsed.data);
    return apiSuccess(updated);
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

    const service = new HypothesisService(await createHypothesisRepository());
    await service.archive(id);
    return apiSuccess({ ok: true });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
