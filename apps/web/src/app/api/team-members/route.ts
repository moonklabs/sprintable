import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { checkMemberLimit } from '@/lib/check-feature';
import { parseBody, createTeamMemberSchema } from '@sprintable/shared';
import { managedAgentRegistrationConfigSchema } from '@/lib/managed-agent-contract';
import { isOssMode, createTeamMemberRepository } from '@/lib/storage/factory';
import { AuditLogService } from '@/services/audit-log.service';

export async function GET(request: Request) {
  if (isOssMode()) {
    const { OSS_PROJECT_ID, OSS_ORG_ID } = await import('@sprintable/storage-sqlite');
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id') ?? OSS_PROJECT_ID;
    const type = searchParams.get('type') as 'human' | 'agent' | null;
    const repo = await createTeamMemberRepository();
    const members = await repo.list({ org_id: OSS_ORG_ID, project_id: projectId, ...(type ? { type } : {}) });
    return apiSuccess(members);
  }
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const includeInactive = searchParams.get('include_inactive') === 'true';

    if (includeInactive) {
      const me = await getMyTeamMember(supabase, user);
      if (!me) return ApiErrors.forbidden('Team member not found');

      const { data: orgMember, error: orgMemberError } = await supabase
        .from('org_members')
        .select('role')
        .eq('org_id', me.org_id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (orgMemberError) throw orgMemberError;
      if (!orgMember || !['owner', 'admin'].includes(orgMember.role as string)) {
        return ApiErrors.forbidden('Admin access required');
      }
    }

    let query = supabase
      .from('team_members')
      .select('id, name, type, role, user_id, project_id, is_active, webhook_url')
      .order('name');

    if (!includeInactive) query = query.eq('is_active', true);
    if (projectId) query = query.eq('project_id', projectId);

    const { data, error } = await query;
    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — 프로젝트 멤버 추가/재활성화 */
export async function POST(request: Request) {
  if (isOssMode()) {
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
  }
  try {
    const supabase = await createSupabaseServerClient();
    // AC4: API Key로 접근하는 에이전트는 admin scope 필요
    const { getAuthContext } = await import('@/lib/auth-helpers');
    const meScope = await getAuthContext(supabase, request);
    if (meScope?.type === 'agent' && !meScope.scope?.includes('admin')) {
      return ApiErrors.insufficientScope('admin');
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const parsed = await parseBody(request, createTeamMemberSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    const projectId = body.project_id ?? me.project_id;
    const type = body.type;

    if (!projectId) return ApiErrors.badRequest('project_id required');

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, org_id')
      .eq('id', projectId)
      .maybeSingle();

    if (projectError) throw projectError;
    if (!project || project.org_id !== me.org_id) return ApiErrors.badRequest('Invalid project_id');

    if (type === 'human') {
      if (!body.user_id) return ApiErrors.badRequest('user_id required for human member');

      const { data: orgMember, error: orgMemberError } = await supabase
        .from('org_members')
        .select('id')
        .eq('org_id', me.org_id)
        .eq('user_id', body.user_id)
        .maybeSingle();

      if (orgMemberError) throw orgMemberError;
      if (!orgMember) return ApiErrors.badRequest('User is not a member of this organization');

      const { data: existing, error: existingError } = await supabase
        .from('team_members')
        .select('id, name, type, is_active')
        .eq('org_id', me.org_id)
        .eq('project_id', projectId)
        .eq('type', 'human')
        .eq('user_id', body.user_id)
        .maybeSingle();

      if (existingError) throw existingError;

      if (existing) {
        if (existing.is_active) {
          return apiError('DUPLICATE_MEMBER', 'Member already assigned to this project.', 400);
        }

        const { data: reactivated, error: reactivateError } = await supabase
          .from('team_members')
          .update({
            is_active: true,
            name: body.name ?? existing.name,
            role: body.role ?? 'member',
          })
          .eq('id', existing.id)
          .select('id, name, type, role, user_id, project_id, is_active')
          .single();

        if (reactivateError) throw reactivateError;
        new AuditLogService(createSupabaseAdminClient()).log({
          org_id: me.org_id as string,
          actor_id: user.id,
          action: 'member_added',
          target_user_id: body.user_id ?? null,
          new_role: body.role ?? 'member',
        }).catch(() => {});
        return apiSuccess(reactivated, undefined, 201);
      }

      const { data: profile, error: profileError } = await supabase
        .from('team_members')
        .select('name')
        .eq('org_id', me.org_id)
        .eq('user_id', body.user_id)
        .eq('type', 'human')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (profileError) throw profileError;
      const name = body.name ?? profile?.name;
      if (!name) return ApiErrors.badRequest('name required');

      const { data, error } = await supabase
        .from('team_members')
        .insert({
          org_id: me.org_id,
          project_id: projectId,
          type: 'human',
          name,
          role: body.role ?? 'member',
          user_id: body.user_id,
        })
        .select('id, name, type, role, user_id, project_id, is_active')
        .single();

      if (error) throw error;
      new AuditLogService(createSupabaseAdminClient()).log({
        org_id: me.org_id as string,
        actor_id: user.id,
        action: 'member_added',
        target_user_id: body.user_id ?? null,
        new_role: body.role ?? 'member',
      }).catch(() => {});
      return apiSuccess(data, undefined, 201);
    }

    const memberCheck = await checkMemberLimit(supabase, me.org_id);
    if (!memberCheck.allowed) {
      return apiError('UPGRADE_REQUIRED', memberCheck.reason ?? 'Member limit reached. Upgrade to Team.', 403);
    }

    const parsedAgentConfig = managedAgentRegistrationConfigSchema.safeParse(body.agent_config);
    if (!parsedAgentConfig.success) {
      return ApiErrors.badRequest(parsedAgentConfig.error.issues.map((issue) => issue.message).join(', '));
    }

    const { data, error } = await supabase
      .from('team_members')
      .insert({
        org_id: me.org_id,
        project_id: projectId,
        type,
        name: body.name,
        role: body.role ?? 'member',
        user_id: body.user_id ?? null,
        agent_config: parsedAgentConfig.data,
        ...(body.webhook_url ? { webhook_url: body.webhook_url } : {}),
      })
      .select('id, name, type, role, user_id, project_id, is_active, webhook_url')
      .single();

    if (error) throw error;
    new AuditLogService(createSupabaseAdminClient()).log({
      org_id: me.org_id as string,
      actor_id: user.id,
      action: 'member_added',
      target_user_id: body.user_id ?? null,
      new_role: body.role ?? 'member',
    }).catch(() => {});
    return apiSuccess(data, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
