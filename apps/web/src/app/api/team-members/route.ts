import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { parseBody, createTeamMemberSchema } from '@sprintable/shared';
import { createTeamMemberRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { getAuthContext } from '@/lib/auth-helpers';

export async function GET(request: Request) {
  try {
    const res = await proxyToFastapi(request, '/api/v2/team-members');
    if (!res.ok) return res;
    const data: unknown = await res.json();
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — 프로젝트 멤버 추가/재활성화 */
export async function POST(request: Request) {
  try {
    const parsed = await parseBody(request, createTeamMemberSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;
    if (!body.name) return ApiErrors.badRequest('name required for agent');
    const _r = await proxyToFastapi(request, '/api/v2/team-members');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
