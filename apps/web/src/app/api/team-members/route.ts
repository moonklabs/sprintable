import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { parseBody, createTeamMemberSchema } from '@sprintable/shared';
import { isOssMode, createTeamMemberRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  try {
    if (isOssMode()) {
      const { OSS_PROJECT_ID, OSS_ORG_ID } = await import('@sprintable/storage-pglite');
      const { searchParams } = new URL(request.url);
      const projectId = searchParams.get('project_id') ?? OSS_PROJECT_ID;
      const type = searchParams.get('type') as 'human' | 'agent' | null;
      const repo = await createTeamMemberRepository();
      const members = await repo.list({ org_id: OSS_ORG_ID, project_id: projectId, ...(type ? { type } : {}) });
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
    const parsed = await parseBody(request, createTeamMemberSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;
    if (body.type !== 'agent') {
      const _r = await proxyToFastapi(request, '/api/v2/team-members');
      if (!_r.ok) return _r;
      if (_r.status === 204) return apiSuccess({ ok: true });
      return apiSuccess(await _r.json());
    }
    if (!body.name) return ApiErrors.badRequest('name required for agent');
    if (isOssMode()) {
      const { OSS_PROJECT_ID, OSS_ORG_ID } = await import('@sprintable/storage-pglite');
      const repo = await createTeamMemberRepository();
      const member = await repo.create({
        org_id: OSS_ORG_ID,
        project_id: body.project_id ?? OSS_PROJECT_ID,
        name: body.name,
        type: 'agent',
        role: body.role ?? 'member',
      });
      return apiSuccess(member, undefined, 201);
    }
const _r = await proxyToFastapi(request, '/api/v2/team-members');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
