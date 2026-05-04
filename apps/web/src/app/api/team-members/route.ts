import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { parseBody, createTeamMemberSchema } from '@sprintable/shared';
import { isOssMode, createTeamMemberRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { getAuthContext } from '@/lib/auth-helpers';

export async function GET(request: Request) {
  try {
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();
      const { searchParams } = new URL(request.url);
      const projectId = searchParams.get('project_id') ?? me.project_id;
      const type = searchParams.get('type') as 'human' | 'agent' | null;
      const repo = await createTeamMemberRepository();
      const includeInactive = searchParams.get('include_inactive') === 'true';
      const members = await repo.list({ org_id: me.org_id, project_id: projectId, ...(type ? { type } : {}), ...(includeInactive ? {} : { is_active: true }) });
      return apiSuccess(members);
    }
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
    if (isOssMode()) {
      const me = await getAuthContext(request);
      if (!me) return ApiErrors.unauthorized();

      let body: unknown;
      try { body = await request.json(); } catch { return ApiErrors.badRequest('Invalid JSON body'); }
      const { name, type, role, project_id, webhook_url, email } = (body as Record<string, unknown>) ?? {};
      const memberType = (type as string) === 'agent' ? 'agent' : 'human';
      if (!name || typeof name !== 'string' || !name.trim()) return ApiErrors.badRequest('name is required');

      const repo = await createTeamMemberRepository();
      const member = await repo.create({
        org_id: me.org_id,
        project_id: typeof project_id === 'string' ? project_id : me.project_id,
        name: name.trim(),
        type: memberType,
        role: typeof role === 'string' ? role : 'member',
        email: typeof email === 'string' ? email : undefined,
      });
      if (typeof webhook_url === 'string' && webhook_url) {
        await repo.update(member.id, { webhook_url } as Parameters<typeof repo.update>[1]);
      }
      return apiSuccess(member, undefined, 201);
    }

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
