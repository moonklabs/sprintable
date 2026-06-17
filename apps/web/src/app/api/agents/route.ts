import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * POST — org-level 에이전트 생성 (S3, story 1c947ff5).
 *
 * BE `POST /api/v2/agents`(OrgAgentCreate)로 프록시. 단일 project 종속(team-members create)과 달리
 * `scope_mode`로 프로젝트 집합을 받아 members/api_key 1개 + N 프로젝트 grant 를 fan-out 한다(빌링=1좌석).
 * org_id·인가는 BE 가 verified context 로 해소 — body 로 넘기지 않는다. `/api/team-members` 프록시 패턴 미러.
 */
export async function POST(request: Request) {
  try {
    const body = JSON.parse(await request.text()) as Record<string, unknown>;

    // 클라 방어(BE 가 권위 검증) — 폼 disabled 와 동일 규칙.
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    const scopeMode = body['scope_mode'];
    const projectIds = Array.isArray(body['project_ids']) ? body['project_ids'] : [];
    const issues: Array<{ path: string; message: string }> = [];
    if (!name) issues.push({ path: 'name', message: 'name is required' });
    if (scopeMode !== 'org' && scopeMode !== 'projects') {
      issues.push({ path: 'scope_mode', message: "scope_mode must be 'org' or 'projects'" });
    }
    if (scopeMode === 'projects' && projectIds.length === 0) {
      issues.push({ path: 'project_ids', message: "project_ids required when scope_mode='projects'" });
    }
    if (issues.length > 0) return ApiErrors.validationFailed(issues);

    // 검증된 body로 새 Request를 만들어 FastAPI로 proxy (원본 request body는 이미 소비됨).
    const proxied = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify({ ...body, name }),
    });
    const res = await proxyToFastapi(proxied, '/api/v2/agents');
    if (!res.ok) return res;
    return apiSuccess(await res.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
