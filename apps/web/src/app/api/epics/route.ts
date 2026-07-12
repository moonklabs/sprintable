import { createEpicSchema } from '@sprintable/shared';

import { EpicService, type CreateEpicInput } from '@/services/epic';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';
import { createEpicRepository } from '@/lib/storage/factory';

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);
    const orderBy = searchParams.get('order_by') ?? undefined;
    // 로드맵 조타(wedge #2): order_by="position"은 복합 정렬((position IS NULL) ASC, position ASC,
    // created_at DESC)이라 BE가 X-Next-Cursor를 내지 않는다 → 커서 이어달리기 불가. 이 모드는
    // 전량 로드가 전제이므로 over-fetch(+1)/커서 없이 요청 limit 그대로 받아 hasMore=false로 봉인(AC4).
    const positionMode = orderBy === 'position';
    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: positionMode ? undefined : searchParams.get('cursor'),
    }, { defaultLimit: 50, maxLimit: 100 });
    const repo = await createEpicRepository();
    const service = new EpicService(repo);
    // 569f5316: 백엔드 GET /api/v2/epics 가 cursor/limit/order_by + total(X-Total-Count)을 지원하므로
    // in-memory 페이징(1000+ silent-truncation 유발) 대신 BE에 위임한다. over-fetch(+1)로 hasMore 판단.
    const epics = await service.list({
      project_id: searchParams.get('project_id') ?? undefined,
      limit: positionMode ? pageInput.limit : pageInput.limit + 1,
      cursor: positionMode ? undefined : pageInput.cursor,
      order_by: orderBy,
    });
    if (positionMode) {
      return apiSuccess(epics, { limit: pageInput.limit, hasMore: false, nextCursor: null });
    }
    const { page, meta } = buildCursorPageMeta(epics, pageInput.limit, 'created_at');
    return apiSuccess(page, meta);
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    // 권한(에픽 생성 = agent 또는 admin/owner)은 BE 단일 소스에서 강제한다 — create_epic →
    // enforce_body_context → has_project_access(team_member ∪ grant ∪ owner/admin org-wide·canonical).
    // (이전 FE role 체크는 dbClient=undefined 하드코딩이라 getEpicActorRole이 항상 null → owner도 무조건
    //  403나던 데모-브레이커. BE authz가 SSOT이므로 FE 중복 게이트 제거가 정답·thin proxy.)

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return apiError('BAD_REQUEST', 'Invalid JSON body', 400);
    }
    if (!rawBody || typeof rawBody !== 'object') {
      return apiError('BAD_REQUEST', 'Body must be an object', 400);
    }
    const body = rawBody as Record<string, unknown>;
    if (!body.project_id) body.project_id = me.project_id;
    if (!body.org_id) body.org_id = me.org_id;
    const parsed = createEpicSchema.safeParse(body);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    const repo = await createEpicRepository();
    const service = new EpicService(repo);
    const epic = await service.create(parsed.data as unknown as CreateEpicInput);
    return apiSuccess(epic, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
