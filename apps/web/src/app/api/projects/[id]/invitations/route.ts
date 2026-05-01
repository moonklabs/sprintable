import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { checkMemberLimit } from '@/lib/check-feature';
import { parseBody, createInvitationSchema } from '@sprintable/shared';
import { isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

/** POST /api/projects/:id/invitations — 프로젝트 레벨 초대 생성 */
export async function POST(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Invitations are not supported in OSS mode.', 501);
  try {
    const { id: projectId } = await params;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const parsed = await parseBody(request, createInvitationSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

    // 프로젝트가 이 org에 속하는지 검증
    const { data: project } = await supabase
      .from('projects')
      .select('id, org_id')
      .eq('id', projectId)
      .eq('org_id', me.org_id)
      .is('deleted_at', null)
      .maybeSingle();

    if (!project) return ApiErrors.notFound('Project not found');

    const email = body.email;

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

    // 중복 초대 체크 (동일 org + email + project 조합)
    const { data: existing } = await supabase
      .from('invitations')
      .select('id')
      .eq('org_id', me.org_id)
      .eq('email', email)
      .eq('project_id', projectId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (existing) return apiError('DUPLICATE_INVITE', 'Invitation already pending', 400);

    const { data, error } = await supabase
      .from('invitations')
      .insert({
        org_id: me.org_id,
        email,
        role: body.role ?? 'member',
        invited_by: me.id,
        project_id: projectId,
      })
      .select('id, token, email, expires_at, project_id')
      .single();

    if (error) throw error;

    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/invite?token=${data.token}`;

    return apiSuccess({ ...data, invite_url: inviteUrl }, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
