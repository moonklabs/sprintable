import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/db/admin';
import { decodeMcpOAuthState } from '@/lib/mcp-oauth-state';
import { exchangeGitHubOAuthCode } from '@/services/project-mcp';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;

  try {
    const code = url.searchParams.get('code');
    const state = decodeMcpOAuthState(url.searchParams.get('state'));
    const error = url.searchParams.get('error');

    if (error || !code || !state || state.serverKey !== 'github') {
      return NextResponse.redirect(`${origin}/dashboard/settings?mcp_connection=github_error`);
    }

    const admin = createAdminClient();
    await exchangeGitHubOAuthCode(admin as never, {
      code,
      origin,
      orgId: state.orgId,
      projectId: state.projectId,
      actorId: state.actorId,
    });

    return NextResponse.redirect(`${origin}/dashboard/settings?mcp_connection=github_connected`);
  } catch {
    return NextResponse.redirect(`${origin}/dashboard/settings?mcp_connection=github_error`);
  }
}
