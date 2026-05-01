import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { checkProjectLimit } from '@/lib/check-feature';
import { parseBody, createProjectSchema } from '@sprintable/shared';
import { isOssMode, createProjectRepository } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClientType = any;

async function resolveOrgAccess(
  supabase: SupabaseClientType,
  userId: string,
  requestedOrgId: string | null,
) {
  const orgMembershipsQuery = supabase
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  const { data: orgMemberships, error: membershipError } = requestedOrgId
    ? await orgMembershipsQuery.eq('org_id', requestedOrgId)
    : await orgMembershipsQuery.limit(2);

  if (membershipError) throw membershipError;

  if (!orgMemberships || orgMemberships.length === 0) {
    return null;
  }

  if (!requestedOrgId && orgMemberships.length > 1) {
    return { error: ApiErrors.badRequest('org_id required') };
  }

  const [membership] = orgMemberships;
  if (!membership) {
    return null;
  }

  return {
    orgId: membership.org_id as string,
    role: membership.role as string,
  };
}

/** GET — 조직 프로젝트 목록 */
export async function GET(request: Request) {
  if (isOssMode()) {
    const { OSS_ORG_ID, OSS_PROJECT_ID } = await import('@sprintable/storage-sqlite');
    const repo = await createProjectRepository();
    const project = await repo.getById(OSS_PROJECT_ID);
    return apiSuccess(project ? [{ id: project.id, name: project.name, description: null, org_id: OSS_ORG_ID }] : []);
  }
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { searchParams } = new URL(request.url);
    const requestedOrgId = searchParams.get('org_id');
    const orgAccess = await resolveOrgAccess(supabase, user.id, requestedOrgId);

    if (orgAccess?.error) return orgAccess.error;
    if (!orgAccess) return ApiErrors.forbidden('Organization membership not found');

    const includeDeleted = searchParams.get('include_deleted') === 'true';

    let query = supabase
      .from('projects')
      .select('id, name, description, created_at, deleted_at')
      .eq('org_id', orgAccess.orgId);

    if (!includeDeleted) {
      query = query.is('deleted_at', null);
    }

    const { data, error } = await query.order('created_at', { ascending: true });

    if (error) throw error;
    return apiSuccess(data ?? []);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — 프로젝트 생성 (Feature Gating: max_projects 체크) */
export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Project creation is not supported in OSS mode.', 501);
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const parsed = await parseBody(request, createProjectSchema);
    if (!parsed.success) return parsed.response;
    const { org_id: orgId, name, description } = parsed.data;

    const orgAccess = await resolveOrgAccess(supabase, user.id, orgId);
    if (orgAccess?.error) return orgAccess.error;
    if (!orgAccess) return ApiErrors.forbidden('Organization membership not found');
    if (!['owner', 'admin'].includes(orgAccess.role)) {
      return ApiErrors.forbidden('Admin access required');
    }

    const projectCheck = await checkProjectLimit(supabase, orgId);
    if (!projectCheck.allowed) {
      return apiError('UPGRADE_REQUIRED', projectCheck.reason ?? 'Project limit reached. Upgrade to Team.', 403);
    }

    const creatorName = user.user_metadata?.name
      || user.user_metadata?.full_name
      || user.email
      || 'Unknown user';

    const { data, error } = await supabase.rpc('create_project_with_creator_membership', {
      _org_id: orgId,
      _name: name,
      _description: description ?? null,
      _creator_name: creatorName,
    });

    if (error) throw error;
    if (!data || typeof data !== 'object') {
      throw new Error('project_create_result_missing');
    }

    return apiSuccess(data, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
