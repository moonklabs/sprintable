import { apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { BridgeInboundService } from '@/services/bridge-inbound';
import { AgentHitlService, HitlConflictError } from '@/services/agent-hitl';
import { syncSlackHitlRequestState, type SlackHitlRequestContext } from '@/services/slack-hitl';
import { verifySlackSignature } from '@/services/slack-inbound';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

interface SlackInteractionPayload {
  type: string;
  user?: { id?: string; username?: string; name?: string };
  team?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string };
  message?: { ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
}

const ALLOWED_ACTION_IDS = new Set(['hitl_approve', 'hitl_reject']);

function parseActionValue(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { requestId?: string };
    return parsed.requestId ?? null;
  } catch {
    return null;
  }
}

function getRejectReason(payload: SlackInteractionPayload) {
  const label = payload.user?.username ?? payload.user?.name ?? payload.user?.id ?? 'Slack admin';
  return `${label}가 Slack에서 거부한`;
}

function getInteractionBinding(payload: SlackInteractionPayload) {
  return {
    teamId: payload.team?.id ?? null,
    channelId: payload.channel?.id ?? payload.container?.channel_id ?? null,
    messageTs: payload.container?.message_ts ?? payload.message?.ts ?? null,
  };
}

function matchesSlackInteractionSource(metadata: Record<string, unknown> | null | undefined, payload: SlackInteractionPayload) {
  const expectedTeamId = typeof metadata?.slack_team_id === 'string' ? metadata.slack_team_id : null;
  const expectedChannelId = typeof metadata?.slack_channel_id === 'string' ? metadata.slack_channel_id : null;
  const expectedMessageTs = typeof metadata?.slack_message_ts === 'string' ? metadata.slack_message_ts : null;
  const binding = getInteractionBinding(payload);

  if (!expectedChannelId || !expectedMessageTs) return false;
  if (binding.channelId !== expectedChannelId) return false;
  if (binding.messageTs !== expectedMessageTs) return false;
  if (expectedTeamId && binding.teamId !== expectedTeamId) return false;
  return true;
}

async function loadHitlRequest(supabase: Pick<SupabaseClient, 'from'>, requestId: string) {
  const { data, error } = await supabase
    .from('agent_hitl_requests')
    .select('id, org_id, project_id, title, prompt, requested_for, status, response_text, expires_at, metadata')
    .eq('id', requestId)
    .maybeSingle();

  if (error) throw error;
  return (data as SlackHitlRequestContext | null) ?? null;
}

export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
  const signingSecret = process.env['SLACK_SIGNING_SECRET'];
  if (!signingSecret) {
    return Response.json({ text: 'Slack signing secret missing' }, { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-slack-signature');
  const timestamp = request.headers.get('x-slack-request-timestamp');
  if (!verifySlackSignature(signingSecret, signature, timestamp, rawBody)) {
    return Response.json({ text: 'Invalid Slack signature' }, { status: 401 });
  }

  const form = new URLSearchParams(rawBody);
  const payloadRaw = form.get('payload');
  if (!payloadRaw) {
    return Response.json({ text: 'Missing payload' }, { status: 400 });
  }

  const payload = JSON.parse(payloadRaw) as SlackInteractionPayload;
  const action = payload.actions?.[0];
  const requestId = parseActionValue(action?.value);
  if (!requestId || !action?.action_id) {
    return Response.json({ response_type: 'ephemeral', text: 'HITL 요청 정보를 읽지 못한.' }, { status: 400 });
  }
  if (!ALLOWED_ACTION_IDS.has(action.action_id)) {
    return Response.json({ response_type: 'ephemeral', text: '지원하지 않는 HITL action인.' }, { status: 400 });
  }

  const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ text: 'Supabase service role is not configured' }, { status: 500 });
  }

  const supabase = (await import('@supabase/supabase-js')).createClient(supabaseUrl, serviceRoleKey);
  const requestRow = await loadHitlRequest(supabase, requestId);
  if (!requestRow) {
    return Response.json({ response_type: 'ephemeral', text: 'HITL 요청을 찾지 못한.' }, { status: 404 });
  }

  if (!matchesSlackInteractionSource(requestRow.metadata ?? null, payload)) {
    return Response.json({ response_type: 'ephemeral', text: '원본 Slack HITL 메시지와 일치하지 않는 요청인.' }, { status: 400 });
  }

  const bridgeService = new BridgeInboundService(supabase as never);
  const userId = payload.user?.id ?? null;
  if (!userId) {
    return Response.json({ response_type: 'ephemeral', text: 'Slack 사용자 정보를 확인하지 못한.' });
  }

  const mapping = await bridgeService.findUserMapping(requestRow.org_id, requestRow.project_id, 'slack', userId);
  if (!mapping) {
    return Response.json({ response_type: 'ephemeral', text: 'Slack 계정이 Sprintable 팀원에 연결되지 않은.' });
  }

  const service = new AgentHitlService(supabase as never);
  const actionKind = action.action_id === 'hitl_approve' ? 'approve' : 'reject';

  try {
    await service.respond({
      requestId,
      actorId: mapping.team_member_id,
      orgId: requestRow.org_id,
      projectId: requestRow.project_id,
      action: actionKind,
      comment: actionKind === 'reject' ? getRejectReason(payload) : 'Slack에서 승인한',
    });

    return Response.json({
      response_type: 'ephemeral',
      text: actionKind === 'approve' ? 'HITL 승인 처리한.' : 'HITL 거부 처리한.',
    });
  } catch (error) {
    if (error instanceof HitlConflictError) {
      const latest = await loadHitlRequest(supabase, requestId);
      if (latest) {
        const metadata = (latest.metadata ?? {}) as Record<string, unknown>;
        await syncSlackHitlRequestState(supabase as never, {
          request: latest,
          hitlMemoId: typeof metadata.hitl_memo_id === 'string' ? metadata.hitl_memo_id : null,
          sourceMemoId: typeof metadata.source_memo_id === 'string' ? metadata.source_memo_id : null,
          actorId: mapping.team_member_id,
        }, {
          appUrl: process.env.NEXT_PUBLIC_APP_URL,
          logger: console,
        });
      }

      return Response.json({ response_type: 'ephemeral', text: '이미 처리된 HITL 요청인.' });
    }

    return Response.json({ response_type: 'ephemeral', text: 'Slack HITL 처리 중 오류가 발생한.' }, { status: 500 });
  }
}
