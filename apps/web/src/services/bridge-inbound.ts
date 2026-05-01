// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PostgrestError = any;
import { MemoService, type CreateMemoInput } from './memo';

export type BridgePlatform = 'slack' | 'discord' | 'teams' | 'telegram';

export interface BridgeInboundEvent {
  channelId: string;
  userId: string | null;
  eventId: string | null;
  messageText: string;
  messageTs: string | null;
  threadTs: string | null;
  teamId: string | null;
  raw: unknown;
}

export interface BridgeChannelMapping {
  id: string;
  org_id: string;
  project_id: string;
  platform: BridgePlatform;
  channel_id: string;
  config: Record<string, string> | null;
  is_active: boolean;
}

export interface BridgeUserMapping {
  team_member_id: string;
  display_name: string | null;
}

export interface BridgeInboundResult {
  action: 'created' | 'ignored' | 'rate_limited';
  memoId?: string;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_PER_CHANNEL = 60;
const rateBuckets = new Map<string, number[]>();

export function checkChannelRateLimit(key: string, now = Date.now()): boolean {
  const bucket = rateBuckets.get(key) ?? [];
  const recent = bucket.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX_PER_CHANNEL) {
    rateBuckets.set(key, recent);
    return false;
  }

  recent.push(now);
  rateBuckets.set(key, recent);
  return true;
}

export function resetBridgeRateLimiter() {
  rateBuckets.clear();
}

export function normalizeBridgeMetadata(platform: BridgePlatform, event: BridgeInboundEvent) {
  const metadata: Record<string, unknown> = {
    source: platform,
    channel_id: event.channelId,
    thread_ts: event.threadTs,
    team_id: event.teamId,
  };

  if (event.eventId) {
    metadata.event_id = event.eventId;
  }

  if (platform === 'slack') {
    metadata.slack_ts = event.messageTs;
  }

  if (platform === 'discord') {
    metadata.discord_message_id = event.messageTs;
    metadata.thread_id = event.threadTs;
    metadata.guild_id = event.teamId;
  }

  if (platform === 'teams') {
    const raw = (typeof event.raw === 'object' && event.raw !== null ? event.raw : {}) as {
      id?: string;
      serviceUrl?: string;
      conversation?: { id?: string };
      channelData?: { channel?: { id?: string }; team?: { id?: string }; tenant?: { id?: string } };
    };
    metadata.teams_activity_id = raw.id ?? event.messageTs;
    metadata.teams_service_url = raw.serviceUrl ?? null;
    metadata.teams_conversation_id = raw.conversation?.id ?? event.threadTs ?? event.channelId;
    metadata.teams_channel_id = raw.channelData?.channel?.id ?? event.channelId;
    metadata.teams_team_id = raw.channelData?.team?.id ?? event.teamId;
    metadata.teams_tenant_id = raw.channelData?.tenant?.id ?? event.teamId;
  }

  return metadata;
}

function buildMemoTitle(messageText: string, unknownUserLabel: string | null) {
  const preview = (messageText.trim() || 'Bridge message').slice(0, 80);
  return unknownUserLabel ? `[${unknownUserLabel}] ${preview}` : preview;
}

function buildMemoContent(platform: BridgePlatform, event: BridgeInboundEvent, unknownUserLabel: string | null) {
  const body = event.messageText.trim() || '(빈 메시지)';
  if (!unknownUserLabel) return body;

  return [
    `[${unknownUserLabel}]`,
    `${platform}_user_id: ${event.userId ?? 'unknown'}`,
    '',
    body,
  ].join('\n');
}

function isBridgeDuplicateMemoError(error: unknown): error is PostgrestError {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === '23505';
}

export class BridgeInboundService {
  constructor(private readonly supabase: SupabaseClient) {}

  async findChannelMapping(platform: BridgePlatform, channelId: string): Promise<BridgeChannelMapping | null> {
    const { data } = await this.supabase
      .from('messaging_bridge_channels')
      .select('id, org_id, project_id, platform, channel_id, config, is_active')
      .eq('platform', platform)
      .eq('channel_id', channelId)
      .eq('is_active', true)
      .maybeSingle();

    return (data as BridgeChannelMapping | null) ?? null;
  }

  async findUserMapping(orgId: string, projectId: string, platform: BridgePlatform, platformUserId: string): Promise<BridgeUserMapping | null> {
    const { data } = await this.supabase
      .from('messaging_bridge_users')
      .select('team_member_id, display_name')
      .eq('org_id', orgId)
      .eq('platform', platform)
      .eq('platform_user_id', platformUserId)
      .eq('is_active', true)
      .maybeSingle();

    const mapping = (data as BridgeUserMapping | null) ?? null;
    if (!mapping) return null;

    const { data: scopedMember } = await this.supabase
      .from('team_members')
      .select('id')
      .eq('id', mapping.team_member_id)
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('is_active', true)
      .maybeSingle();

    if (!scopedMember) return null;

    return mapping;
  }

  async findExistingMemoByEventId(
    orgId: string,
    projectId: string,
    platform: BridgePlatform,
    eventId: string | null,
  ): Promise<string | null> {
    if (!eventId) return null;

    const { data } = await this.supabase
      .from('memos')
      .select('id')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .contains('metadata', { source: platform, event_id: eventId })
      .limit(1)
      .maybeSingle();

    return (data as { id: string } | null)?.id ?? null;
  }

  async findFallbackAuthor(orgId: string, projectId: string): Promise<string | null> {
    const { data: agent } = await this.supabase
      .from('team_members')
      .select('id')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('type', 'agent')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (agent?.id) return agent.id as string;

    const { data: human } = await this.supabase
      .from('team_members')
      .select('id')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('type', 'human')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    return (human as { id: string } | null)?.id ?? null;
  }

  async processInboundMessage(input: {
    platform: BridgePlatform;
    mapping: BridgeChannelMapping;
    event: BridgeInboundEvent;
    unknownUserLabel?: string;
  }): Promise<BridgeInboundResult> {
    if (!input.event.userId) {
      return { action: 'ignored' };
    }

    if (!checkChannelRateLimit(`${input.platform}:${input.mapping.channel_id}`)) {
      return { action: 'rate_limited' };
    }

    const userMapping = await this.findUserMapping(
      input.mapping.org_id,
      input.mapping.project_id,
      input.platform,
      input.event.userId,
    );
    const authorId = userMapping?.team_member_id
      ?? await this.findFallbackAuthor(input.mapping.org_id, input.mapping.project_id);

    if (!authorId) {
      return { action: 'ignored' };
    }

    const unknownUserLabel = userMapping ? null : (input.unknownUserLabel ?? `${input.platform} 연동 미설정 사용자`);
    const metadata = normalizeBridgeMetadata(input.platform, input.event);
    const memoService = MemoService.fromSupabase(this.supabase);

    try {
      const memo = await memoService.create({
        project_id: input.mapping.project_id,
        org_id: input.mapping.org_id,
        title: buildMemoTitle(input.event.messageText, unknownUserLabel),
        content: buildMemoContent(input.platform, input.event, unknownUserLabel),
        memo_type: 'memo',
        created_by: authorId,
        metadata,
      } as CreateMemoInput);

      return { action: 'created', memoId: memo.id as string };
    } catch (error) {
      if (input.event.eventId && isBridgeDuplicateMemoError(error)) {
        const existingMemoId = await this.findExistingMemoByEventId(
          input.mapping.org_id,
          input.mapping.project_id,
          input.platform,
          input.event.eventId,
        );
        if (existingMemoId) {
          return { action: 'ignored', memoId: existingMemoId };
        }
      }

      throw error;
    }
  }
}
