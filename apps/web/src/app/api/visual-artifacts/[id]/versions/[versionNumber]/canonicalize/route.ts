import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; versionNumber: string }> };

/**
 * POST /api/visual-artifacts/{id}/versions/{versionNumber}/canonicalize — E-CANVAS C4-S8.
 * 정본 제안(propose-only) — 승인은 always-HITL(gate_service), BE가 artifact_canonicalize
 * Gate를 생성. 승인/반려는 신규 UI 없이 기존 /inbox?tab=gates(GateInbox)의 generic
 * POST /api/gates/{id}/transition이 처리(§1 에이전트 제안/인간 승인 재사용).
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id, versionNumber } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/visual-artifacts/${id}/versions/${versionNumber}/canonicalize`);
    if (!_r.ok) return _r;
    const json = (await _r.json()) as { data?: unknown };
    return apiSuccess(json.data ?? null, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
