import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createTeamMemberRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  try {
    if (isOssMode()) {
      const { OSS_MEMBER_ID, OSS_ORG_ID } = await import('@sprintable/storage-pglite');
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();

      const repo = await createTeamMemberRepository();
      const members = await repo.list({ org_id: OSS_ORG_ID });
      const member = members.find((m) => m.id === (me.id ?? OSS_MEMBER_ID));
      if (!member) return ApiErrors.notFound('Member not found');
      return apiSuccess({ ...member, email: null });
    }
    const res = await proxyToFastapi(request, '/api/v2/me');
    if (!res.ok) return res;
    const data: unknown = await res.json();
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    if (isOssMode()) {
      const { OSS_MEMBER_ID } = await import('@sprintable/storage-pglite');
      let body: unknown;
      try { body = await request.json(); } catch { return apiError('BAD_REQUEST', 'Invalid JSON body', 400); }
      const { name } = (body as Record<string, unknown>) ?? {};
      if (typeof name !== 'string' || !name.trim()) return apiError('VALIDATION_ERROR', 'name is required', 400);

      const repo = await createTeamMemberRepository();
      const updated = await repo.update(OSS_MEMBER_ID, { name: name.trim() });
      return apiSuccess({ ...updated, email: null });
    }
const _r = await proxyToFastapi(request, '/api/v2/me');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
