import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { parseBody, createTeamMemberSchema } from '@sprintable/shared';
import { managedAgentRegistrationConfigSchema } from '@/lib/managed-agent-contract';
import { createTeamMemberRepository } from '@/lib/storage/factory';

export async function GET(request: Request) {
  try {
    const { OSS_PROJECT_ID, OSS_ORG_ID } = await import('@sprintable/storage-sqlite');
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id') ?? OSS_PROJECT_ID;
    const type = searchParams.get('type') as 'human' | 'agent' | null;
    const repo = await createTeamMemberRepository();
    const members = await repo.list({ org_id: OSS_ORG_ID, project_id: projectId, ...(type ? { type } : {}) });
    return apiSuccess(members);
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
    if (body.type !== 'agent') return apiError('NOT_IMPLEMENTED', 'Only agent members are supported in OSS mode.', 501);
    if (!body.name) return ApiErrors.badRequest('name required for agent');
    const { OSS_PROJECT_ID, OSS_ORG_ID } = await import('@sprintable/storage-sqlite');
    const repo = await createTeamMemberRepository();
    const member = await repo.create({
      org_id: OSS_ORG_ID,
      project_id: body.project_id ?? OSS_PROJECT_ID,
      name: body.name,
      type: 'agent',
      role: body.role ?? 'member',
    });
    return apiSuccess(member, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
