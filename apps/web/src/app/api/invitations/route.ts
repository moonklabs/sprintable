import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { checkMemberLimit } from '@/lib/check-feature';
import { parseBody, createInvitationSchema } from '@sprintable/shared';
import { isOssMode } from '@/lib/storage/factory';

/** GET — 초대 목록 (admin 이상만) */
export async function GET() {
  if (isOssMode()) return apiSuccess([]);
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    // admin 권한 체크
    const { data: orgMember } = await supabase
      .from('org_members')
      .select('role')
      .eq('org_id', me.org_id)
      .eq('user_id', user.id)
      .single();

    if (!orgMember || !['owner', 'admin'].includes(orgMember.role as string)) {
      return ApiErrors.forbidden('Admin access required');
    }

    const { data, error } = await supabase
      .from('invitations')
      .select('*, projects(id, name)')
      .eq('org_id', me.org_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}

/** POST — 초대 생성 */
export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Invitations are not supported in OSS mode.', 501);
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const parsed = await parseBody(request, createInvitationSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    const email = body.email;
    const projectId = body.project_id ?? null;

    const { data: existingOrgMember, error: existingOrgMemberError } = await supabase
      .rpc('is_existing_org_member_email', { _org_id: me.org_id, _email: email });

    if (existingOrgMemberError) throw existingOrgMemberError;

    // 신규 org member 초대일 때만 멤버 제한 체크
    if (!existingOrgMember) {
      const memberCheck = await checkMemberLimit(supabase, me.org_id);
      if (!memberCheck.allowed) {
        return apiError('UPGRADE_REQUIRED', memberCheck.reason ?? 'Member limit reached', 403);
      }
    }

    // project_id가 지정된 경우 해당 프로젝트가 org에 속하는지 검증
    if (projectId) {
      const { data: project } = await supabase
        .from('projects')
        .select('id')
        .eq('id', projectId)
        .eq('org_id', me.org_id)
        .maybeSingle();
      if (!project) return ApiErrors.badRequest('Invalid project_id');
    }

    // 중복 초대 체크 (동일 org + email + project 조합)
    const dupQuery = supabase
      .from('invitations')
      .select('id')
      .eq('org_id', me.org_id)
      .eq('email', email)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString());

    if (projectId) {
      dupQuery.eq('project_id', projectId);
    } else {
      dupQuery.is('project_id', null);
    }

    const { data: existing } = await dupQuery.maybeSingle();

    if (existing) return apiError('DUPLICATE_INVITE', 'Invitation already pending', 400);

    const { data, error } = await supabase
      .from('invitations')
      .insert({
        org_id: me.org_id,
        email,
        role: body.role ?? 'member',
        invited_by: me.id,
        ...(projectId ? { project_id: projectId } : {}),
      })
      .select('id, token, email, expires_at, project_id')
      .single();

    if (error) throw error;

    // 초대 링크 생성
    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/invite?token=${data.token}`;

    return apiSuccess({ ...data, invite_url: inviteUrl }, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
