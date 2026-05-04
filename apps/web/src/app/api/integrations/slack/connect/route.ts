import { NextResponse } from 'next/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiError, ApiErrors } from '@/lib/api-response';
;
import { buildSlackConnectUrl } from '@/services/slack-channel-mapping';

export async function GET() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = null;
  const me = await getMyTeamMember(db, null as any);
  if (!me) return ApiErrors.forbidden('Team member not found');

  const { data: orgMember } = await db
    .from('org_members')
    .select('role')
    .eq('org_id', me.org_id)
    .eq('user_id', me.id)
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
