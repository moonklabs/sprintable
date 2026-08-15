import { hypothesisGuidedCreateSchema } from '@sprintable/shared';
import { HypothesisService } from '@/services/hypothesis';
import { createHypothesisRepository } from '@/lib/storage/factory';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

// story #2542(BE PR#2942) — guided 3부 폼 전용 생성. 형제(/api/hypotheses POST)와 동형
// thin proxy(같은 apiSuccess {data} envelope) — 다른 필드셋(statement+metric+target+
// direction)이라 별도 라우트로 뺐다(같은 라우트에서 두 body shape를 분기하지 않는다).
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const parsed = hypothesisGuidedCreateSchema.safeParse(await request.json());
    if (!parsed.success) return ApiErrors.badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');

    const service = new HypothesisService(await createHypothesisRepository());
    const created = await service.createGuided(parsed.data);
    return apiSuccess(created);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
