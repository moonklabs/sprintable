import { createEpicSchema } from '@sprintable/shared';

import { GoalService, type CreateEpicInput } from '@/services/goal';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';
import { createGoalRepository } from '@/lib/storage/factory';

// story #2262 PR②(BE #2905) — story ca37b2b0과 동일 상한, FE에서 먼저 잘라 BE 422를 피한다.
const IDS_BATCH_CAP = 200;

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const { searchParams } = new URL(request.url);

    // story #2262 PR② — ids 배치 lookup은 커서 페이지네이션과 무관한 고정 집합 조회
    // (stories/route.ts의 ids 분기와 동일 패턴 — project_id 없이도 org 전체에서 조회한다).
    const idsParam = searchParams.get('ids');
    const parsedIds = idsParam ? idsParam.split(',').map((id) => id.trim()).filter(Boolean).slice(0, IDS_BATCH_CAP) : [];
    if (parsedIds.length > 0) {
      const repo = await createGoalRepository();
      const service = new GoalService(repo);
      const epics = await service.list({ ids: parsedIds, limit: parsedIds.length });
      return apiSuccess(epics);
    }

    const orderBy = searchParams.get('order_by') ?? undefined;
    // 로드맵 조타(wedge #2): order_by="position"은 복합 정렬((position IS NULL) ASC, position ASC,
    // created_at DESC)이라 BE가 X-Next-Cursor를 내지 않는다 → 커서 이어달리기 불가. 이 모드는
    // 전량 로드가 전제이므로 over-fetch(+1)/커서 없이 요청 limit 그대로 받는다.
    const positionMode = orderBy === 'position';
    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: positionMode ? undefined : searchParams.get('cursor'),
    }, { defaultLimit: 50, maxLimit: 100 });

    if (positionMode) {
      // story #3705 — 이 모드는 예전에 `hasMore: false`를 하드코딩했다(에픽이 limit을 넘는
      // 프로젝트에서 "받은 게 전부"라고 단정 — #4049/#4052/#4054와 같은 얼굴, glance 아크가
      // 100건 넘는 프로젝트에서 조용히 잘림). BE `GET /api/v2/goals`는 X-Total-Count를
      // 이미 주는데(같은 헤더를 이 파일 cursor 분기 아래 `service.list()`가 거치는
      // fastapiCall이 조용히 버린다 — body만 반환) 이걸 안 읽었을 뿐이다. 헤더 접근이
      // 필요한 이 한 자리만 backlog/route.ts(#2190)와 동일하게 프록시 직행 — repository
      // 계약(IEpicRepository)은 그대로 두고 cursor 분기도 안 건드린다.
      const upstreamUrl = new URL(request.url);
      upstreamUrl.searchParams.set('limit', String(pageInput.limit));
      upstreamUrl.searchParams.delete('cursor'); // position 모드는 커서 무의미(이어달리기 불가)
      const upstreamRequest = new Request(upstreamUrl.toString(), request);
      const _r = await proxyToFastapi(upstreamRequest, '/api/v2/goals');
      if (!_r.ok) return _r;
      const epics = (await _r.json()) as unknown[];
      const totalHeader = _r.headers.get('x-total-count');
      // 총계를 못 받으면(계약 위반·프록시 실패) "이게 전부"라고 단정하지 않는다 — null(모름),
      // false로 위장하지 않는다.
      //
      // 유나 design CHANGES①(PR #4059, 2026-09-09) — `Number(totalHeader)`가 헤더 값이
      // 숫자가 아닐 때(계약 위반) NaN이 되는데, `NaN === null`은 거짓이라 이 갈래를
      // 못 잡고 `hasMore = epics.length < NaN`이 false로 떨어졌다. NaN은 JSON 직렬화에서
      // null이 되므로 나가는 봉투가 `{totalCount:null, hasMore:false}`("총계는 모르는데
      // 더 없는 건 확실하다") — 이 파일이 지키려는 "모르면 단정 안 함" 약속을 봉투 스스로
      // 깨는 자리였다. Number.isFinite로 명시 가드해 숫자 아닌 헤더도 null로 통일한다.
      const parsed = totalHeader === null ? null : Number(totalHeader);
      const totalCount = parsed !== null && Number.isFinite(parsed) ? parsed : null;
      const hasMore = totalCount === null ? null : epics.length < totalCount;
      return apiSuccess(epics, { limit: pageInput.limit, hasMore, nextCursor: null, totalCount });
    }

    const repo = await createGoalRepository();
    const service = new GoalService(repo);
    // 569f5316: 백엔드 GET /api/v2/epics 가 cursor/limit/order_by + total(X-Total-Count)을 지원하므로
    // in-memory 페이징(1000+ silent-truncation 유발) 대신 BE에 위임한다. over-fetch(+1)로 hasMore 판단.
    const epics = await service.list({
      project_id: searchParams.get('project_id') ?? undefined,
      limit: pageInput.limit + 1,
      cursor: pageInput.cursor,
      order_by: orderBy,
      // 결함 fix(2026-07-30) — `include=glance`가 여기서 한 번도 읽힌 적이 없어 story
      // #2298/#2303의 participant_ids/focal_story 옵트인이 BE까지 한 번도 도달하지
      // 못했다(선생님이 /flow에서 본 "열린 스토리가 없다"의 진짜 근본 — PR#2680의
      // "focal_story 있는 active 에픽 우선" 로직은 focal_story가 애초에 안 오니 항상
      // 폴백만 타는 죽은 코드였다). BE는 정확히 "glance" 리터럴만 특별취급하므로 그대로 전달.
      include: searchParams.get('include') ?? undefined,
    });
    const { page, meta } = buildCursorPageMeta(epics, pageInput.limit, 'created_at');
    // story #3705 AC3 — position 모드가 totalCount를 갖게 됐으니 이 분기도 같은 meta 키를
    // 갖는다(형상 일관성). cursor 모드는 이 축을 안 읽으므로 null(모름 — 0/미측정을 섞지 않는
    // house 관례를 새 필드에도 적용).
    return apiSuccess(page, { ...meta, totalCount: null });
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
    const repo = await createGoalRepository();
    const service = new GoalService(repo);
    const epic = await service.create(parsed.data as unknown as CreateEpicInput);
    return apiSuccess(epic, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
