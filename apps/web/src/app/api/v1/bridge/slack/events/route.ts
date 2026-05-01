import { apiError, apiSuccess } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
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
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
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

  // SaaS overlay에서 처리
  return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
}
