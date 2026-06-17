import { draftHypothesisSchema } from '@sprintable/shared';
import { HypothesisService } from '@/services/hypothesis';
import { createHypothesisRepository } from '@/lib/storage/factory';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';

// POST — 흐름 부산물에서 가설 초안 생성(E1-S10 §3.9). persist=false(기본)=미리보기,
// persist=true=status='proposed' row 생성(drafted_by_member_id 기록). thin proxy over
// HypothesisService → BE raw 응답을 apiSuccess {data} 엔벨로프로 래핑(hypotheses/route.ts 패턴).
// 정적 세그먼트 `draft`는 `[id]`보다 우선되어 라우트 shadow 없음(BE §3.9.7과 동형).
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const parsed = draftHypothesisSchema.safeParse(await request.json());
    if (!parsed.success) return ApiErrors.badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');

    const service = new HypothesisService(await createHypothesisRepository());
    const draft = await service.draft(parsed.data);
    return apiSuccess(draft);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
