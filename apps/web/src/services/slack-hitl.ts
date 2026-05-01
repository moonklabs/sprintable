// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { isExpiredIsoTimestamp, resolveMessagingBridgeSecretRef } from './slack-channel-mapping';
import { buildSlackMemoLink, isSlackSourceMemo } from './slack-outbound-dispatcher';

export interface SlackHitlRequestContext {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  prompt: string;
  requested_for: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'resolved';
  response_text: string | null;
  expires_at: string | null;
  metadata: Record<string, unknown> | null;
}

interface SlackAuthRow {
  access_token_ref: string;
  expires_at: string | null;
}

interface SlackUserRow {
  id: string;
  name: string | null;
}

interface SlackPostResult {
  ok: boolean;
  status: number;
  error: string;
  ts?: string;
}

interface SlackUpdateResult {
  ok: boolean;
  status: number;
  error: string;
  ts?: string;
}

interface SlackHitlDeps {
  fetchFn?: typeof fetch;
  logger?: Pick<Console, 'warn' | 'error'>;
  appUrl?: string;
}

const FAILURE_COMMENT_PREFIX = 'Slack HITL 전송 실패';
const SLACK_API_URL = 'https://slack.com/api';

type SlackBlock = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatDeadline(deadline: string | null) {
  if (!deadline) return '기한 미정';
  return new Date(deadline).toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function buildActionValue(requestId: string) {
  return JSON.stringify({ requestId });
}

export function buildSlackHitlBlocks(input: {
  requestId: string;
  title: string;
  prompt: string;
  assigneeName: string;
  hitlMemoLink: string;
  sourceMemoLink: string | null;
  expiresAt: string | null;
  status: SlackHitlRequestContext['status'];
  responseText?: string | null;
}) {
  const statusLine = input.status === 'pending'
    ? `담당 관리자: ${input.assigneeName} · 응답 기한: ${formatDeadline(input.expiresAt)}`
    : input.status === 'approved'
      ? `처리 상태: 승인 완료${input.responseText ? ` · 코멘트: ${input.responseText}` : ''}`
      : input.status === 'rejected'
        ? `처리 상태: 거부 완료${input.responseText ? ` · 사유: ${input.responseText}` : ''}`
        : `처리 상태: ${input.status}`;

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [`*HITL 승인 요청*`, `*${input.title}*`, input.prompt].join('\n'),
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: statusLine,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `<${input.hitlMemoLink}|Sprintable HITL 메모 열기>`,
          input.sourceMemoLink ? ` · <${input.sourceMemoLink}|원본 메모 보기>` : '',
        ].join(''),
      },
    },
  ];

  if (input.status === 'pending') {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '승인' },
          style: 'primary',
          action_id: 'hitl_approve',
          value: buildActionValue(input.requestId),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '거부' },
          style: 'danger',
          action_id: 'hitl_reject',
          value: buildActionValue(input.requestId),
          confirm: {
            title: { type: 'plain_text', text: '거부 확인' },
            text: { type: 'mrkdwn', text: '이 요청을 거부하고 run을 종료하는지?' },
            confirm: { type: 'plain_text', text: '거부' },
            deny: { type: 'plain_text', text: '취소' },
          },
        },
      ],
    });
  }

  return blocks;
}

async function postSlackJson(
  token: string,
  endpoint: 'chat.postMessage' | 'chat.update',
  body: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<SlackPostResult | SlackUpdateResult> {
  const response = await fetchFn(`${SLACK_API_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });

  const json = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; ts?: string };
  return {
    ok: response.ok && json.ok === true,
    status: response.status,
    error: json.error ?? (!response.ok ? `http_${response.status}` : 'slack_api_error'),
    ts: json.ts,
  };
}

async function getActiveSlackToken(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from('messaging_bridge_org_auths')
    .select('access_token_ref, expires_at')
    .eq('org_id', orgId)
    .eq('platform', 'slack')
    .maybeSingle();

  if (error) throw error;
  const auth = (data as SlackAuthRow | null) ?? null;
  if (!auth) return null;

  const token = resolveMessagingBridgeSecretRef(auth.access_token_ref);
  if (!token || isExpiredIsoTimestamp(auth.expires_at)) return null;
  return token;
}

async function getTeamMemberName(supabase: SupabaseClient, teamMemberId: string) {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, name')
    .eq('id', teamMemberId)
    .maybeSingle();

  if (error) throw error;
  const member = (data as SlackUserRow | null) ?? null;
  return member?.name?.trim() || '담당 관리자';
}

async function appendFailureComment(
  supabase: SupabaseClient,
  memoId: string | null,
  createdBy: string,
  reason: string,
) {
  if (!memoId) return;
  await supabase
    .from('memo_replies')
    .insert({
      memo_id: memoId,
      created_by: createdBy,
      content: `${FAILURE_COMMENT_PREFIX}\n- reason: ${reason}`,
      review_type: 'comment',
    });
}

async function updateRequestMetadata(
  supabase: SupabaseClient,
  requestId: string,
  nextMetadata: Record<string, unknown>,
) {
  const { error } = await supabase
    .from('agent_hitl_requests')
    .update({ metadata: nextMetadata })
    .eq('id', requestId);

  if (error) throw error;
}

export async function notifySlackHitlRequest(
  supabase: SupabaseClient,
  input: {
    request: SlackHitlRequestContext;
    sourceMemo: { id: string; metadata: Record<string, unknown> | null };
    hitlMemoId: string;
    createdBy: string;
  },
  deps: SlackHitlDeps = {},
) {
  const logger = deps.logger ?? console;
  const fetchFn = deps.fetchFn ?? fetch;

  if (!isSlackSourceMemo(input.sourceMemo.metadata)) {
    return { status: 'skipped' as const, reason: 'memo_not_slack_source' };
  }

  const token = await getActiveSlackToken(supabase, input.request.org_id);
  if (!token) {
    await appendFailureComment(supabase, input.hitlMemoId, input.createdBy, 'slack_auth_missing');
    return { status: 'failed' as const, reason: 'slack_auth_missing' };
  }

  const channelId = String(input.sourceMemo.metadata.channel_id);
  const threadTs = typeof input.sourceMemo.metadata.thread_ts === 'string'
    ? input.sourceMemo.metadata.thread_ts
    : typeof input.sourceMemo.metadata.slack_ts === 'string'
      ? input.sourceMemo.metadata.slack_ts
      : null;
  const assigneeName = await getTeamMemberName(supabase, input.request.requested_for);
  const hitlMemoLink = buildSlackMemoLink(deps.appUrl, input.hitlMemoId);
  const sourceMemoLink = buildSlackMemoLink(deps.appUrl, input.sourceMemo.id);
  const blocks = buildSlackHitlBlocks({
    requestId: input.request.id,
    title: input.request.title,
    prompt: input.request.prompt,
    assigneeName,
    hitlMemoLink,
    sourceMemoLink,
    expiresAt: input.request.expires_at,
    status: 'pending',
    responseText: null,
  });

  try {
    const result = await postSlackJson(token, 'chat.postMessage', {
      channel: channelId,
      thread_ts: threadTs ?? undefined,
      text: `HITL 승인 요청 · ${input.request.title}`,
      blocks,
    }, fetchFn);

    if (!result.ok || !result.ts) {
      await appendFailureComment(supabase, input.hitlMemoId, input.createdBy, result.error);
      return { status: 'failed' as const, reason: result.error };
    }

    await updateRequestMetadata(supabase, input.request.id, {
      ...(input.request.metadata ?? {}),
      slack_team_id: typeof input.sourceMemo.metadata.team_id === 'string' ? input.sourceMemo.metadata.team_id : null,
      slack_channel_id: channelId,
      slack_thread_ts: threadTs,
      slack_message_ts: result.ts,
    });

    return { status: 'sent' as const, ts: result.ts };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'slack_hitl_send_failed';
    logger.warn?.(`[SlackHitl] notify failed: ${reason}`);
    await appendFailureComment(supabase, input.hitlMemoId, input.createdBy, reason);
    return { status: 'failed' as const, reason };
  }
}

export async function syncSlackHitlRequestState(
  supabase: SupabaseClient,
  input: {
    request: SlackHitlRequestContext;
    hitlMemoId: string | null;
    sourceMemoId: string | null;
    actorId: string;
  },
  deps: SlackHitlDeps = {},
) {
  const logger = deps.logger ?? console;
  const fetchFn = deps.fetchFn ?? fetch;
  const metadata = input.request.metadata ?? {};
  if (!isObject(metadata)) {
    return { status: 'skipped' as const, reason: 'request_metadata_missing' };
  }

  const channelId = typeof metadata.slack_channel_id === 'string' ? metadata.slack_channel_id : null;
  const messageTs = typeof metadata.slack_message_ts === 'string' ? metadata.slack_message_ts : null;
  if (!channelId || !messageTs) {
    return { status: 'skipped' as const, reason: 'slack_message_missing' };
  }

  const token = await getActiveSlackToken(supabase, input.request.org_id);
  if (!token) {
    await appendFailureComment(supabase, input.hitlMemoId, input.actorId, 'slack_auth_missing');
    return { status: 'failed' as const, reason: 'slack_auth_missing' };
  }

  const assigneeName = await getTeamMemberName(supabase, input.request.requested_for);
  const hitlMemoLink = input.hitlMemoId ? buildSlackMemoLink(deps.appUrl, input.hitlMemoId) : buildSlackMemoLink(deps.appUrl, '');
  const sourceMemoLink = input.sourceMemoId ? buildSlackMemoLink(deps.appUrl, input.sourceMemoId) : null;
  const blocks = buildSlackHitlBlocks({
    requestId: input.request.id,
    title: input.request.title,
    prompt: input.request.prompt,
    assigneeName,
    hitlMemoLink,
    sourceMemoLink,
    expiresAt: input.request.expires_at,
    status: input.request.status,
    responseText: input.request.response_text,
  });

  try {
    const result = await postSlackJson(token, 'chat.update', {
      channel: channelId,
      ts: messageTs,
      text: `HITL ${input.request.status} · ${input.request.title}`,
      blocks,
    }, fetchFn);

    if (!result.ok) {
      await appendFailureComment(supabase, input.hitlMemoId, input.actorId, result.error);
      return { status: 'failed' as const, reason: result.error };
    }

    return { status: 'updated' as const };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'slack_hitl_update_failed';
    logger.warn?.(`[SlackHitl] sync failed: ${reason}`);
    await appendFailureComment(supabase, input.hitlMemoId, input.actorId, reason);
    return { status: 'failed' as const, reason };
  }
}
