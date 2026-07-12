import { EpicService, type EpicPositionItem } from '@/services/epic';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { createEpicRepository } from '@/lib/storage/factory';

/**
 * PATCH /api/epics/bulk — 로드맵 조타 재정렬(wedge #2·story 2258ccd6). 큐레이션한 에픽만
 * position 세팅(백필0)해 BE `PATCH /api/v2/epics/bulk`로 실 persist(낙관 아님). 인가(org/project·
 * SEC-S8 W/W2)는 BE 단일 소스라 FE는 thin proxy — 형상만 검증하고 items를 그대로 포워드한다.
 */
export async function PATCH(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return apiError('BAD_REQUEST', 'Invalid JSON body', 400);
    }
    if (!rawBody || typeof rawBody !== 'object') {
      return apiError('BAD_REQUEST', 'Body must be an object', 400);
    }
    const rawItems = (rawBody as Record<string, unknown>).items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return apiError('VALIDATION_ERROR', 'items must be a non-empty array', 400);
    }
    const items: EpicPositionItem[] = [];
    for (const it of rawItems) {
      if (!it || typeof it !== 'object') {
        return apiError('VALIDATION_ERROR', 'each item must be an object', 400);
      }
      const { id, position } = it as Record<string, unknown>;
      if (typeof id !== 'string' || !id) {
        return apiError('VALIDATION_ERROR', 'item.id must be a non-empty string', 400);
      }
      if (typeof position !== 'number' || !Number.isInteger(position)) {
        return apiError('VALIDATION_ERROR', 'item.position must be an integer', 400);
      }
      items.push({ id, position });
    }

    const repo = await createEpicRepository();
    const service = new EpicService(repo);
    const updated = await service.bulkUpdatePositions(items);
    return apiSuccess(updated);
  } catch (err: unknown) { return handleApiError(err); }
}
