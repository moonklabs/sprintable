import { createHypothesisSchema } from '@sprintable/shared';
import { HypothesisService } from '@/services/hypothesis';
import { createHypothesisRepository } from '@/lib/storage/factory';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

// Thin proxy over HypothesisService → wraps the BE raw response in an apiSuccess {data}
// envelope (epics/route.ts pattern). The repository talks raw to FastAPI; this route is
// the one place {data} is added, so the client consumer reads json.data (E1-S8 §9 / fc4d4264).
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id is required');

    const service = new HypothesisService(await createHypothesisRepository());
    const hypotheses = await service.list({
      project_id: projectId,
      epic_id: searchParams.get('epic_id') ?? undefined,
      story_id: searchParams.get('story_id') ?? undefined,
    });
    return apiSuccess(hypotheses);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const parsed = createHypothesisSchema.safeParse(await request.json());
    if (!parsed.success) return ApiErrors.badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');

    const service = new HypothesisService(await createHypothesisRepository());
    const created = await service.create(parsed.data);
    return apiSuccess(created);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
