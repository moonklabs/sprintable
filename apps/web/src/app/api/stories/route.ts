
import { createStorySchema } from '@sprintable/shared';

import { StoryService, type CreateStoryInput } from '@/services/story';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { checkResourceLimit } from '@/lib/check-feature';
import { buildCursorPageMeta, parseCursorPageInput } from '@/lib/pagination';
import { createStoryRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    const check = await checkResourceLimit(dbClient!, me.org_id, 'max_stories', 'stories');
    if (!check.allowed) return apiError('UPGRADE_REQUIRED', check.reason ?? 'Story limit reached. Upgrade to Team.', 403);

    const rawBody = await request.json();
    if (!rawBody.project_id) rawBody.project_id = me.project_id;
    if (!rawBody.org_id) rawBody.org_id = me.org_id;
    const parsed = createStorySchema.safeParse(rawBody);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    const repo = await createStoryRepository();
    const service = new StoryService(repo, dbClient);
    const story = await service.create(parsed.data as CreateStoryInput);
    return apiSuccess(story, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// story ca37b2b0 — BE 배치 lookup(#2131) cap과 동일 상한. FE에서 먼저 잘라 보내 BE 422를 피한다.
const IDS_BATCH_CAP = 200;

export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    const { searchParams } = new URL(request.url);
    const idsParam = searchParams.get('ids');
    const parsedIds = idsParam ? idsParam.split(',').map((id) => id.trim()).filter(Boolean).slice(0, IDS_BATCH_CAP) : [];
    const ids = parsedIds.length > 0 ? parsedIds : undefined;

    // story #2534 카디르 QA HIGH(2026-08-09) — 미매달림 버킷 카운트가 stories.length
    // (limit=100에 잘린 페이지 길이)였다. BE(stories.py:233)는 unattached 필터를 WHERE
    // 레벨에서 걸러 X-Total-Count로 «정확한 전체 총계»를 이미 낸다(story #2190 backlog
    // route와 동형 헤더) — StoryService 추상 대신 raw proxy로 그 헤더를 그대로 meta.total에
    // 실어 보낸다(limit=100은 목록 표시용으로 그대로, 카운트만 헤더 기준으로 정직해진다).
    //
    // story #3160 — no_sprint=true도 같은 이유로 이 조기 분기에 합류한다: BE가 no_sprint일 때
    // 완전히 다른 분기(list_backlog, cursor 미지원·X-Total-Count 계약)를 타서 아래 cursor
    // 페이지네이션(service.list) 가정과 안 맞는다(#2534와 동형 판단, story #3160). raw proxy는
    // 원본 쿼리스트링을 그대로 전달하므로(fastapi-proxy.ts) exclude_status 등 다른 파라미터도
    // 이 분기에선 이미 화이트리스트 없이 통과한다 — «화이트리스트 유지」 결정은 아래 cursor
    // 경로(service.list)에만 적용된다.
    if (searchParams.get('unattached') === 'true' || searchParams.get('no_sprint') === 'true') {
      const _r = await proxyToFastapi(request, '/api/v2/stories');
      if (!_r.ok) return _r;
      const data = await _r.json();
      const totalHeader = _r.headers.get('x-total-count');
      return apiSuccess(data, totalHeader !== null ? { total: Number(totalHeader) } : undefined);
    }

    const repo = await createStoryRepository();
    const service = new StoryService(repo, dbClient);

    // ids 배치 lookup은 커서 페이지네이션과 무관한 고정 집합 조회 — 페이지 meta 없이 그대로 반환.
    if (ids && ids.length > 0) {
      const stories = await service.list({
        project_id: searchParams.get('project_id') ?? undefined,
        ids,
        limit: ids.length,
      });
      return apiSuccess(stories);
    }

    const pageInput = parseCursorPageInput({
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
      cursor: searchParams.get('cursor'),
    }, { defaultLimit: 50, maxLimit: 100 });
    const storyNumberParam = searchParams.get('story_number');
    const stories = await service.list({
      sprint_id: searchParams.get('sprint_id') ?? undefined,
      epic_id: searchParams.get('epic_id') ?? undefined,
      assignee_id: searchParams.get('assignee_id') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      project_id: searchParams.get('project_id') ?? undefined,
      q: searchParams.get('q') ?? undefined,
      unassigned: searchParams.get('unassigned') === 'true' ? true : undefined,
      // story #2534(E-FLOW-V4 S4) — 가설/목표 둘 다 미매달림(unassigned와 다른 축).
      unattached: searchParams.get('unattached') === 'true' ? true : undefined,
      story_number: storyNumberParam ? Number(storyNumberParam) : undefined,
      // story #2328(C-11 ㉡층) — 083176e8/story_number와 같은 클래스(있는 필드가 프록시에서
      // 빠지는 것) 재발 방지로 처음부터 포함.
      boost_candidates_from: searchParams.get('boost_candidates_from') ?? undefined,
      // story #3019(실사고 처방) — epic_ids(comma-separated)+epic_unassigned+done_within_days.
      // 이 셋이 함께 오면 buildCursorPageMeta의 limit+1 오버페치 계약을 그대로 타 hasMore가
      // 정확히 서는 좁혀진(스코프 축소) 결과에 대해서도 성립한다 — 별도 분기 불요.
      epic_ids: searchParams.get('epic_ids')?.split(',').map((id) => id.trim()).filter(Boolean),
      epic_unassigned: searchParams.get('epic_unassigned') === 'true' ? true : undefined,
      done_within_days: searchParams.get('done_within_days') ? Number(searchParams.get('done_within_days')) : undefined,
      // story #3148/#3160 — 같은 클래스 재발(위 boost_candidates_from/epic_ids류와 동형)
      // 방지로 신설과 동시에 포함. cursor 페이지네이션과 안 섞이는 no_sprint와 달리 이
      // 필터는 WHERE 절 추가일 뿐이라 cursor 경로와 안전하게 공존한다.
      exclude_status: searchParams.get('exclude_status') ?? undefined,
      limit: pageInput.limit + 1,  // RC3: 오버페치 → buildCursorPageMeta hasMore 판단
      cursor: pageInput.cursor,
    });
    const { page, meta } = buildCursorPageMeta(stories, pageInput.limit, 'created_at');
    return apiSuccess(page, meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
