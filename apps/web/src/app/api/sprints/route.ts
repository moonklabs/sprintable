

import { SprintService, type CreateSprintInput } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext, getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { withRouteTiming } from '@/lib/server-timing';
import { buildHeaderCursorPageMeta } from '@/lib/pagination';
import { createSprintSchema } from '@sprintable/shared';
import { createSprintRepository } from '@/lib/storage/factory';

// POST /api/sprints — 생성
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    let rawBody: unknown;
    try { rawBody = await request.json(); } catch { return apiError('BAD_REQUEST', 'Invalid JSON body', 400); }
    if (!rawBody || typeof rawBody !== 'object') return apiError('BAD_REQUEST', 'Body must be an object', 400);
    const body = rawBody as Record<string, unknown>;
    if (!body.project_id) body.project_id = me.project_id;
    if (!body.org_id) body.org_id = me.org_id;
    const parsed = createSprintSchema.safeParse(body);
    if (!parsed.success) return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    const repo = await createSprintRepository();
    const service = new SprintService(repo, dbClient);
    const sprint = await service.create(parsed.data as CreateSprintInput);
    return apiSuccess(sprint, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// GET /api/sprints — 목록
// story #4299 AC2 — 라우트 전체 계측(합계 · bff_pre · 인증 /me 포함 모든 백엔드 호출 · dev 전용 · 꺼지면 그대로 호출).
export const GET = withRouteTiming('sprints', async (request: Request) => {
  try {
    // story #4346 — 목록 GET은 org/project 판단조차 BE에 맡긴다(rate-limit 칸만 읽음) → JWT claim으로 충분, `/me` 왕복 0.
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    // story #3857 — 예전엔 ApiSprintRepository(packages/storage-api/src/ApiSprintRepository.ts)를
    // 거쳤는데, 그 repo가 fastapiCall(body만 반환)로 BE를 부르는 통에 list_sprints(#2428 PR④)가
    // 내는 X-Total-Count·X-Next-Cursor에 이 라우트가 애초에 도달할 수 없었다(repo 경계에서
    // 이미 유실 — cursor/limit 자체도 repo가 안 실어 보내던 별도 결함). goals/route.ts의
    // positionMode 분기·stories/backlog/route.ts(#2190) 선례와 동일하게 repo를 건너뛰고
    // 직행 프록시로 바꾼다 — BE list_sprints가 project_id·status·limit·cursor·권한 검증까지
    // 전부 자체 처리하므로(require_project_access/accessible_project_ids_in_org) FE 쪽 재구현이
    // 필요 없다(그대로 forward).
    //
    // PO CHANGES③(2026-09-14 09:01Z) 근거 — 원천 동일·shape 정합 확인:
    //   ㉠ 옛 ApiSprintRepository.list()도 결국 이 라우트와 같은 BE 엔드포인트(/api/v2/sprints)를
    //     호출했다(packages/storage-api/src/ApiSprintRepository.ts:12, fastapiCall('GET',
    //     '/api/v2/sprints', ...)) — 데이터 원천 무변경.
    //   ㉡ fastapiCall은 res.json()을 그대로 반환할 뿐(런타임 변환 0, TS 타입 단언만) —
    //     packages/core-storage/src/interfaces/ISprintRepository.ts의 Sprint 인터페이스
    //     필드명이 전부 snake_case(project_id·start_date·outcome_status 등)로 BE
    //     backend/app/schemas/sprint.py::SprintResponse와 1:1 동일하다(field alias 없음) —
    //     repo를 거치든 안 거치든 바이트 단위로 같은 JSON이 나간다.
    //   ㉢ project_id·status 외 파라미터: 옛 repo.list()는 이 둘만 명시적으로 골라 forward하고
    //     cursor/limit은 버렸다(별도 결함, 이 스토리가 고치는 그 자리). 직행 프록시는 원 요청의
    //     querystring 전체를 그대로 넘기므로(fastapi-proxy.ts:69 `url.search`) project_id·status는
    //     당연히 포함되고, BE 라우터가 선언하지 않은 미지 파라미터는 FastAPI가 조용히 무시한다
    //     (422 아님) — 상위 호환(superset), 기존 소비처 회귀 0.
    const _r = await proxyToFastapi(request, '/api/v2/sprints');
    if (!_r.ok) return _r;
    const data = await _r.json();

    // PO CHANGES①(2026-09-14 09:01Z) — X-Next-Cursor는 페이지가 비어 있지 않으면 항상
    // 실리므로(sprints.py:166 `if sprints:`) 존재 자체가 「더 있음」의 증거가 아니다.
    // 판정은 pagination.ts::buildHeaderCursorPageMeta로 위임.
    const { searchParams } = new URL(request.url);
    const requestedLimit = Number(searchParams.get('limit')) || 1000; // BE 미지정 시 기존 동작(최대 1000)과 동일
    const hasCursorParam = Boolean(searchParams.get('cursor'));
    const nextCursor = _r.headers.get('x-next-cursor');
    const totalHeader = _r.headers.get('x-total-count');

    return apiSuccess(data, buildHeaderCursorPageMeta({
      dataLength: Array.isArray(data) ? data.length : 0,
      requestedLimit,
      hasCursorParam,
      nextCursorHeader: nextCursor,
      totalCountHeader: totalHeader !== null ? Number(totalHeader) : null,
    }));
  } catch (err: unknown) {
    return handleApiError(err);
  }
});
