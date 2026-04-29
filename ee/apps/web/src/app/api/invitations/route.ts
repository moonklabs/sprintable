import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { checkMemberEntitlement } from '@/lib/entitlement';
import { parseBody, createInvitationSchema } from '@sprintable/shared';
import { isOssMode } from '@/lib/storage/factory';
import { sendInviteEmail } from '@/lib/email';

export async function GET() {
  if (isOssMode()) return apiSuccess([]);
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { data: orgMember } = await supabase
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!orgMember || !['owner', 'admin'].includes(orgMember.role as string)) {
      return ApiErrors.forbidden('Admin access required');
    }

    const { data, error } = await supabase
      .from('invitations')
      .select('*, projects(id, name)')
      .eq('org_id', orgMember.org_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}

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

    if (!existingOrgMember) {
      const ent = await checkMemberEntitlement(supabase, me.org_id);
      if (!ent.allowed) return apiError('quota_exceeded', `Member quota exceeded (${ent.current}/${ent.limit})`, 402, { resource: 'members', current: ent.current, limit: ent.limit, upgradeUrl: ent.upgradeUrl });
    }

    if (projectId) {
      const { data: project } = await supabase
        .from('projects')
        .select('id')
        .eq('id', projectId)
        .eq('org_id', me.org_id)
        .maybeSingle();
      if (!project) return ApiErrors.badRequest('Invalid project_id');
    }

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

    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/invite?token=${data.token}`;

    // 초대 이메일 best-effort 발송 (실패해도 201 반환)
    void (async () => {
      try {
        const { data: org } = await supabase
          .from('organizations')
          .select('name')
          .eq('id', me.org_id)
          .single();
        await sendInviteEmail({
          to: email,
          inviterName: user.email ?? 'Someone',
          orgName: org?.name ?? 'your organization',
          inviteUrl,
        });
      } catch {
        // silent — invite link still available in response
      }
    })();

    return apiSuccess({ ...data, invite_url: inviteUrl }, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
