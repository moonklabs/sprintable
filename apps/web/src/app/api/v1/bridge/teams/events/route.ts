import { apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { BridgeInboundService } from '@/services/bridge-inbound';
import { getTeamsSourceChannelId, normalizeTeamsActivity, resolveTeamsInboundConfig, shouldIgnoreTeamsActivity, verifyTeamsRequest, type TeamsActivity } from '@/services/teams-inbound';

export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: 'Supabase service role is not configured' }, { status: 500 });
  }

  const activity = await request.json().catch(() => null) as TeamsActivity | null;
  if (!activity) {
    return Response.json({ error: 'Invalid Teams activity payload' }, { status: 400 });
  }

  if (activity.type === 'conversationUpdate') {
    return Response.json({ ok: true });
  }

  const sourceChannelId = getTeamsSourceChannelId(activity);
  if (!sourceChannelId) {
    return Response.json({ error: 'Unable to resolve Teams source channel' }, { status: 400 });
  }

  // SaaS overlay에서 처리
  return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
}
