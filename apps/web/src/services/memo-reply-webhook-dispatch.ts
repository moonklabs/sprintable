
import { buildAbsoluteMemoLink } from './app-url';
import { hasExactMemberMention } from './doc-comment-notifications';
import { buildWebhookSignatureHeaders } from '@/lib/webhook-signature';
import { WebhookDeliveryService } from './webhook-delivery.service';

interface MemoReplyDispatchMemo {
  id: string;
  org_id: string;
  project_id: string;
  title: string | null;
  created_by: string;
  assigned_to: string | null;
  metadata?: Record<string, unknown> | null;
}

interface MemoReplyDispatchReply {
  id: string;
  memo_id: string;
  content: string;
  created_by: string;
}

interface TeamMemberRow {
  id: string;
  name: string | null;
  webhook_url: string | null;
  is_active: boolean;
}

interface MemoReplyParticipantRow {
  created_by: string;
  content: string | null;
}

interface WebhookConfigRow {
  id: string;
  url: string;
  secret: string | null;
  channel: 'discord' | 'slack' | 'google' | 'generic';
}

type Logger = Pick<Console, 'warn' | 'error'>;

export interface DispatchWorkflowMemoReplyWebhooksOptions {
  db?: any;
  memo: MemoReplyDispatchMemo;
  reply: MemoReplyDispatchReply;
  additionalRecipientIds?: string[];
  logger?: Logger;
  fetchFn?: typeof fetch;
  appUrl?: string;
}

export interface DispatchWorkflowMemoReplyWebhooksResult {
  status: 'sent' | 'skipped' | 'failed';
  reason?: string;
  sentCount?: number;
  failedRecipientCount?: number;
}

const FAILURE_COMMENT_PREFIXES = [
  'Discord 전송 실패',
  'Slack 전송 실패',
  'Slack HITL 전송 실패',
  'Microsoft Teams 전송 실패',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDiscordSourceMemo(metadata: unknown): metadata is Record<string, unknown> {
  return isObject(metadata) && metadata.source === 'discord' && typeof metadata.channel_id === 'string';
}

function isSystemFailureReply(content: string) {
  const trimmed = content.trim();
  return FAILURE_COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function buildMemoLink(appUrl: string | undefined, memoId: string): string {
  return buildAbsoluteMemoLink(memoId, appUrl);
}

function detectWebhookFormat(url: string): 'discord' | 'google' | 'slack' | 'generic' {
  if (url.includes('/api/webhooks') && (url.includes('discord.com') || url.includes('discordapp.com'))) {
    return 'discord';
  }

  if (url.includes('chat.googleapis.com')) {
    return 'google';
  }

  if (url.includes('hooks.slack.com')) {
    return 'slack';
  }

  return 'generic';
}

function buildPreview(content: string, maxLength = 50) {
  const normalized = content.replace(/\s+/g, ' ').trim() || '(빈 답신)';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

// Korean honorific suffixes that may follow a first-name mention (e.g. "@까심군" for "까심 아르야")
const KOREAN_HONORIFIC_RE = /^(군|신|쿤|님|씨)/u;

function hasMentionWithHonorific(content: string, namePart: string): boolean {
  const token = `@${namePart}`;
  let idx = content.indexOf(token);
  while (idx !== -1) {
    const pre = idx > 0 ? content[idx - 1] : undefined;
    const after = content.slice(idx + token.length);
    const prefixOk = !pre || /[\s([{<'""']/u.test(pre);
    const suffixOk = !after || /[\s)\]}>,'""'.!?;:]/.test(after[0]) || KOREAN_HONORIFIC_RE.test(after);
    if (prefixOk && suffixOk) return true;
    idx = content.indexOf(token, idx + token.length);
  }
  return false;
}

function extractMentionedMemberIds(contents: string[], members: TeamMemberRow[]) {
  const targets = new Set<string>();

  for (const member of members) {
    const name = member.name?.trim();
    if (!name) continue;

    const firstName = name.includes(' ') ? name.split(/\s+/)[0] : null;

    const matched = contents.some((content) =>
      hasExactMemberMention(content, name) ||
      (firstName !== null && hasMentionWithHonorific(content, firstName)),
    );

    if (matched) targets.add(member.id);
  }

  return targets;
}

interface ResolvedWebhook {
  id: string | null;
  url: string;
  secret: string | null;
  channel: 'discord' | 'slack' | 'google' | 'generic' | null;
}

async function resolveWebhook(
  db: any,
  memo: MemoReplyDispatchMemo,
  member: TeamMemberRow,
): Promise<ResolvedWebhook | null> {
  const { data: projectConfig } = await db
    .from('webhook_configs')
    .select('id, url, secret, channel')
    .eq('org_id', memo.org_id)
    .eq('member_id', member.id)
    .eq('project_id', memo.project_id)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (projectConfig?.url) return projectConfig as WebhookConfigRow;

  const { data: defaultConfig } = await db
    .from('webhook_configs')
    .select('id, url, secret, channel')
    .eq('org_id', memo.org_id)
    .eq('member_id', member.id)
    .is('project_id', null)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (defaultConfig?.url) return defaultConfig as WebhookConfigRow;
  if (member.webhook_url) return { id: null, url: member.webhook_url, secret: null, channel: null };
  return null;
}

async function postWebhook(
  db: any,
  fetchFn: typeof fetch,
  orgId: string,
  webhook: ResolvedWebhook,
  title: string,
  description: string,
) {
  const format = webhook.channel ?? detectWebhookFormat(webhook.url);
  const body = format === 'discord'
    ? JSON.stringify({
        content: `${title}\n${description.substring(0, 500)}`,
        embeds: [{ title, description, color: 0x3B82F6 }],
      })
    : format === 'google' || format === 'slack'
      ? JSON.stringify({ text: `*${title}*\n${description}` })
      : JSON.stringify({ title, description });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildWebhookSignatureHeaders(webhook.secret, body),
  };

  return new WebhookDeliveryService(db).dispatch({
    org_id: orgId,
    webhook_config_id: webhook.id,
    event_type: 'memo.reply',
    url: webhook.url,
    headers,
    body,
    fetchFn,
  });
}

export async function dispatchWorkflowMemoReplyWebhooks(
  options: DispatchWorkflowMemoReplyWebhooksOptions,
): Promise<DispatchWorkflowMemoReplyWebhooksResult> {
  const logger = options.logger ?? console;
  const fetchFn = options.fetchFn ?? fetch;
  const { memo, reply, db, additionalRecipientIds } = options;

  if (!db) return { status: 'skipped', reason: 'oss_mode' };

  if (isSystemFailureReply(reply.content)) {
    return { status: 'skipped', reason: 'system_failure_comment' };
  }

  if (isDiscordSourceMemo(memo.metadata)) {
    return { status: 'skipped', reason: 'discord_source_memo' };
  }

  const [membersResult, priorRepliesResult, assigneesResult] = await Promise.all([
    db
      .from('team_members')
      .select('id, name, webhook_url, is_active')
      .eq('org_id', memo.org_id)
      .eq('project_id', memo.project_id)
      .eq('is_active', true),
    db
      .from('memo_replies')
      .select('created_by, content')
      .eq('memo_id', memo.id),
    db
      .from('memo_assignees')
      .select('member_id')
      .eq('memo_id', memo.id),
  ]);

  if (membersResult.error) throw membersResult.error;
  if (priorRepliesResult.error) throw priorRepliesResult.error;

  const members = (membersResult.data ?? []) as TeamMemberRow[];
  const priorReplies = (priorRepliesResult.data ?? []) as MemoReplyParticipantRow[];
  const memberById = new Map(members.map((member) => [member.id, member]));

  const participants = new Set<string>();
  participants.add(memo.created_by);
  if (memo.assigned_to) participants.add(memo.assigned_to);
  for (const row of (assigneesResult.data ?? [])) {
    participants.add((row as { member_id: string }).member_id);
  }
  for (const priorReply of priorReplies) {
    participants.add(priorReply.created_by);
  }

  const mentionedIds = extractMentionedMemberIds(
    [reply.content, ...priorReplies.map((entry) => entry.content ?? '')],
    members,
  );
  for (const memberId of mentionedIds) {
    participants.add(memberId);
  }
  for (const id of (additionalRecipientIds ?? [])) {
    participants.add(id);
  }

  participants.delete(reply.created_by);

  const authorName = memberById.get(reply.created_by)?.name?.trim() || reply.created_by;
  const preview = buildPreview(reply.content);
  const memoLabel = memo.title?.trim() ? `“${memo.title.trim()}”` : `#${memo.id}`;
  const memoLink = buildMemoLink(options.appUrl, memo.id);
  const title = `💬 답장: ${authorName}`;
  const description = `메모 ${memoLabel}에 답장\n${preview}\n\n${memoLink}`;

  let sentCount = 0;
  let failedRecipientCount = 0;

  for (const participantId of participants) {
    const member = memberById.get(participantId);
    if (!member?.is_active) continue;

    const webhook = await resolveWebhook(db, memo, member);
    if (!webhook) continue;

    try {
      const sent = await postWebhook(db, fetchFn, memo.org_id, webhook, title, description);
      if (sent) {
        sentCount += 1;
      } else {
        failedRecipientCount += 1;
      }
    } catch (error) {
      failedRecipientCount += 1;
      logger.warn('[memo-reply-webhook-dispatch] webhook send failed', {
        memo_id: memo.id,
        reply_id: reply.id,
        recipient_id: member.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (sentCount > 0) {
    return { status: 'sent', sentCount, failedRecipientCount };
  }

  if (failedRecipientCount > 0) {
    return { status: 'failed', reason: 'all_webhook_requests_failed', failedRecipientCount };
  }

  return { status: 'skipped', reason: 'no_webhook_recipients' };
}
