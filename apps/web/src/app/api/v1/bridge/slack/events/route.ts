import { createClient } from '@supabase/supabase-js';
import { apiError, apiSuccess } from '@/lib/api-response';
import { BridgeInboundService } from '@/services/bridge-inbound';
import {
  normalizeSlackEvent,
  postSlackRateLimitNotice,
  resolveSlackBridgeConfig,
  shouldIgnoreSlackMessage,
  verifySlackSignature,
  type SlackEventEnvelope,
} from '@/services/slack-inbound';

export async function POST(request: Request) {
  const signingSecret = process.env['SLACK_SIGNING_SECRET'];
  if (!signingSecret) {
    return apiError('CONFIGURATION_ERROR', 'Slack signing secret not configured', 500);
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-slack-signature');
  const timestamp = request.headers.get('x-slack-request-timestamp');

  if (!verifySlackSignature(signingSecret, signature, timestamp, rawBody)) {
    return apiError('UNAUTHORIZED', 'Invalid Slack signature', 401);
  }

  let payload: SlackEventEnvelope;
  try {
    payload = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    return apiError('BAD_REQUEST', 'Invalid JSON body', 400);
  }

  if (payload.type === 'url_verification') {
    return Response.json({ challenge: payload.challenge ?? '' });
  }

  if (payload.type !== 'event_callback' || !payload.event) {
    return apiSuccess({ action: 'ignored' });
  }

  const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!supabaseUrl || !serviceRoleKey) {
    return apiError('CONFIGURATION_ERROR', 'Supabase service role is not configured', 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const bridgeService = new BridgeInboundService(supabase);
  const channelMapping = await bridgeService.findChannelMapping('slack', payload.event.channel);

  if (!channelMapping) {
    return apiSuccess({ action: 'ignored' });
  }

  const slackConfig = resolveSlackBridgeConfig(channelMapping.config);
  if (shouldIgnoreSlackMessage(payload.event, slackConfig)) {
    return apiSuccess({ action: 'ignored' });
  }

  const result = await bridgeService.processInboundMessage({
    platform: 'slack',
    mapping: channelMapping,
    event: normalizeSlackEvent(payload.event, payload.team_id ?? '', slackConfig, payload.event_id ?? null),
    unknownUserLabel: 'Slack 연동 미설정 사용자',
  });

  if (result.action === 'rate_limited') {
    const noticeSent = slackConfig.botToken
      ? await postSlackRateLimitNotice(slackConfig.botToken, {
          channel: payload.event.channel,
          threadTs: payload.event.thread_ts ?? null,
        })
      : false;

    return apiSuccess({
      action: 'rate_limited',
      memo_id: null,
      notice_sent: noticeSent,
    });
  }

  return apiSuccess({
    action: result.action,
    memo_id: result.memoId ?? null,
    notice_sent: null,
  });
}
