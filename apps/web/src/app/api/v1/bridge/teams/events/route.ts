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

  const supabase = (await import('@supabase/supabase-js')).createClient(supabaseUrl, serviceRoleKey);
  const inboundService = new BridgeInboundService(supabase as never);
  const mapping = await inboundService.findChannelMapping('teams', sourceChannelId);
  if (!mapping) {
    return Response.json({ ok: true, skipped: 'channel_not_mapped' });
  }

  const config = resolveTeamsInboundConfig(mapping.config ?? null);
  const verified = await verifyTeamsRequest({
    authorizationHeader: request.headers.get('authorization'),
    serviceUrl: activity.serviceUrl,
    botAppId: config.botAppId,
  });
  if (!verified) {
    return Response.json({ error: 'Invalid Teams signature' }, { status: 401 });
  }

  if (shouldIgnoreTeamsActivity(activity)) {
    return Response.json({ ok: true, skipped: 'ignored_activity' });
  }

  const result = await inboundService.processInboundMessage({
    platform: 'teams',
    mapping,
    event: normalizeTeamsActivity(activity),
    unknownUserLabel: 'Microsoft Teams 연동 미설정 사용자',
  });

  return Response.json({ ok: true, result });
}
