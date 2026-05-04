import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { isOssMode, createTeamMemberRepository } from '@/lib/storage/factory';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { handleApiError } from '@/lib/api-error';

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      let body: unknown;
      try { body = await request.json(); } catch { return ApiErrors.badRequest('Invalid JSON body'); }
      const { name, webhook_url, role, is_active } = (body as Record<string, unknown>) ?? {};
      const repo = await createTeamMemberRepository();
      const updated = await repo.update(id, {
        ...(typeof name === 'string' ? { name: name.trim() } : {}),
        ...(webhook_url !== undefined ? { webhook_url: typeof webhook_url === 'string' ? webhook_url : null } : {}),
        ...(typeof role === 'string' ? { role } : {}),
        ...(typeof is_active === 'boolean' ? { is_active } : {}),
      });
      return apiSuccess(updated);
    }
    const _r = await proxyToFastapiWithParams(request, '/api/v2/team-members/[id]', { id });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      const repo = await createTeamMemberRepository();
      await repo.update(id, { is_active: false });
      return apiSuccess({ id });
    }
    const _r = await proxyToFastapiWithParams(request, '/api/v2/team-members/[id]', { id });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
