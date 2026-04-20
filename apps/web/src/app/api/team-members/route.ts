import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { checkMemberLimit } from '@/lib/check-feature';
import { parseBody, createTeamMemberSchema } from '@sprintable/shared';
import { managedAgentRegistrationConfigSchema } from '@/lib/managed-agent-contract';
import { isOssMode, createTeamMemberRepository, createMemberRepository, createProjectPermissionsRepository } from '@/lib/storage/factory';

export async function GET(request: Request) {
  if (isOssMode()) {
    const { OSS_PROJECT_ID } = await import('@sprintable/storage-sqlite');
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id') ?? OSS_PROJECT_ID;
    const repo = await createTeamMemberRepository();
    const { OSS_ORG_ID } = await import('@sprintable/storage-sqlite');
    const members = await repo.list({ org_id: OSS_ORG_ID, project_id: projectId });
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
      .select('id, name, type, role, user_id, project_id, is_active')
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
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Member management is not supported in OSS mode.', 501);
  try {
    const supabase = await createSupabaseServerClient();
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

        // org-level member도 재활성화
        const memberRepo = await createMemberRepository(supabase);
        const orgMemberRecord = await memberRepo.getByUserId(body.user_id!, me.org_id);
        if (orgMemberRecord && !orgMemberRecord.is_active) {
          await memberRepo.update(orgMemberRecord.id, { is_active: true });
        }
        if (orgMemberRecord) {
          const permRepo = await createProjectPermissionsRepository(supabase);
          await permRepo.upsert({ member_id: orgMemberRecord.id, project_id: projectId, role: body.role ?? 'member' });
        }

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

      // 1. org-level members upsert
      const memberRepo = await createMemberRepository(supabase);
      const orgMember = await memberRepo.getOrCreate({
        org_id: me.org_id,
        user_id: body.user_id!,
        name,
        type: 'human',
      });

      // 2. project_permissions upsert
      const permRepo = await createProjectPermissionsRepository(supabase);
      await permRepo.upsert({ member_id: orgMember.id, project_id: projectId, role: body.role ?? 'member' });

      // 3. team_members insert (member_id 연결)
      const { data, error } = await supabase
        .from('team_members')
        .insert({
          org_id: me.org_id,
          project_id: projectId,
          type: 'human',
          name,
          role: body.role ?? 'member',
          user_id: body.user_id,
          member_id: orgMember.id,
        })
        .select('id, name, type, role, user_id, project_id, is_active')
        .single();

      if (error) throw error;
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

    // 1. agent org-level member 생성
    const agentMemberRepo = await createMemberRepository(supabase);
    const agentOrgMember = await agentMemberRepo.getOrCreate({
      org_id: me.org_id,
      name: body.name!,
      type: 'agent',
      agent_config: parsedAgentConfig.data as Record<string, unknown>,
    });

    // 2. project_permissions
    const agentPermRepo = await createProjectPermissionsRepository(supabase);
    await agentPermRepo.upsert({ member_id: agentOrgMember.id, project_id: projectId, role: body.role ?? 'member' });

    // 3. team_members insert (member_id 연결)
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
        member_id: agentOrgMember.id,
      })
      .select('id, name, type, role, user_id, project_id, is_active')
      .single();

    if (error) throw error;
    return apiSuccess(data, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
