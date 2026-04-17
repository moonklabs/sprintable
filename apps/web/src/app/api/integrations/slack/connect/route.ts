import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { buildSlackConnectUrl } from '@/services/slack-channel-mapping';

export async function GET() {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return ApiErrors.unauthorized();

  const me = await getMyTeamMember(supabase, user);
  if (!me) return ApiErrors.forbidden('Team member not found');

  const { data: orgMember } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', me.org_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!orgMember || !['owner', 'admin'].includes(orgMember.role as string)) {
    return ApiErrors.forbidden('Admin access required');
  }

  const clientId = process.env['SLACK_CLIENT_ID'];
  const redirectUri = process.env['SLACK_REDIRECT_URI'];
  if (!clientId || !redirectUri) {
    return ApiErrors.badRequest('Slack OAuth is not configured');
  }

  const state = Buffer.from(JSON.stringify({ orgId: me.org_id, projectId: me.project_id, source: 'slack-settings' })).toString('base64url');
  const url = buildSlackConnectUrl({ clientId, redirectUri, state });
  return NextResponse.redirect(url);
}
