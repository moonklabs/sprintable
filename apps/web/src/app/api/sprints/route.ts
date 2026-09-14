

import { SprintService, type CreateSprintInput } from '@/services/sprint';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
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
export async function GET(request: Request) {
  try {
    const me = await getAuthContext(request);
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
    const _r = await proxyToFastapi(request, '/api/v2/sprints');
    if (!_r.ok) return _r;
    const data = await _r.json();

    const { searchParams } = new URL(request.url);
    const requestedLimit = Number(searchParams.get('limit')) || 1000; // BE 미지정 시 기존 동작(최대 1000)과 동일
    const nextCursor = _r.headers.get('x-next-cursor');
    const totalHeader = _r.headers.get('x-total-count');
    const hasMore = Array.isArray(data) && data.length === requestedLimit && nextCursor !== null;

    return apiSuccess(data, {
      limit: requestedLimit,
      hasMore,
      nextCursor: hasMore ? nextCursor : null,
      totalCount: totalHeader !== null ? Number(totalHeader) : null,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
