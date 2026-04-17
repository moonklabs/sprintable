import { z } from 'zod';

const slackAuthTestSchema = z.object({
  ok: z.literal(true),
  team: z.string(),
  team_id: z.string(),
  user_id: z.string().optional(),
});

const slackConversationSchema = z.object({
  id: z.string(),
  name: z.string(),
  is_private: z.boolean().optional(),
  is_member: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  num_members: z.number().optional().nullable(),
});

const slackConversationsListSchema = z.object({
  ok: z.literal(true),
  channels: z.array(slackConversationSchema),
  response_metadata: z.object({ next_cursor: z.string().optional().nullable() }).optional(),
});

const slackErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export class SlackApiError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'SlackApiError';
  }
}

export interface SlackWorkspaceSummary {
  teamName: string;
  teamId: string;
  botUserId: string | null;
}

export interface SlackChannelSummary {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  memberCount: number | null;
}

export interface SlackConnectionSnapshot {
  status: 'connected' | 'channel_fetch_error';
  workspace: SlackWorkspaceSummary;
  channels: SlackChannelSummary[];
  error: { code: string; message: string } | null;
}

export function resolveMessagingBridgeSecretRef(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ref) return null;
  if (ref.startsWith('env:')) return env[ref.slice(4)] ?? null;
  if (ref.startsWith('vault:')) return null;
  return ref;
}

export function isExpiredIsoTimestamp(value: string | null | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) || timestamp <= now;
}

export function buildSlackConnectUrl({
  clientId,
  redirectUri,
  state,
  scopes = ['channels:read', 'groups:read', 'chat:write'],
}: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(','),
    state,
  });

  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

async function fetchSlackJson<T>(
  token: string,
  url: string,
  schema: z.ZodType<T>,
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    cache: 'no-store',
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SlackApiError(`http_${response.status}`, `Slack request failed with status ${response.status}`);
  }

  const errorResult = slackErrorSchema.safeParse(json);
  if (errorResult.success) {
    throw new SlackApiError(errorResult.data.error);
  }

  return schema.parse(json);
}

export async function fetchSlackWorkspace(token: string, fetchFn: typeof fetch = fetch): Promise<SlackWorkspaceSummary> {
  const result = await fetchSlackJson(token, 'https://slack.com/api/auth.test', slackAuthTestSchema, fetchFn);
  return {
    teamName: result.team,
    teamId: result.team_id,
    botUserId: result.user_id ?? null,
  };
}

export async function fetchSlackChannels(token: string, fetchFn: typeof fetch = fetch): Promise<SlackChannelSummary[]> {
  const channels: SlackChannelSummary[] = [];
  let cursor = '';

  do {
    const params = new URLSearchParams({
      limit: '200',
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
    });
    if (cursor) params.set('cursor', cursor);

    const result = await fetchSlackJson(
      token,
      `https://slack.com/api/conversations.list?${params.toString()}`,
      slackConversationsListSchema,
      fetchFn,
    );

    for (const channel of result.channels) {
      if (channel.is_archived) continue;
      channels.push({
        id: channel.id,
        name: channel.name,
        isPrivate: Boolean(channel.is_private),
        isMember: Boolean(channel.is_member),
        memberCount: channel.num_members ?? null,
      });
    }

    cursor = result.response_metadata?.next_cursor?.trim() ?? '';
  } while (cursor);

  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSlackConnectionSnapshot(
  token: string,
  deps: {
    fetchWorkspace?: typeof fetchSlackWorkspace;
    fetchChannels?: typeof fetchSlackChannels;
  } = {},
): Promise<SlackConnectionSnapshot> {
  const workspace = await (deps.fetchWorkspace ?? fetchSlackWorkspace)(token);

  try {
    const channels = await (deps.fetchChannels ?? fetchSlackChannels)(token);
    return {
      status: 'connected',
      workspace,
      channels,
      error: null,
    };
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : 'channel_fetch_failed';
    return {
      status: 'channel_fetch_error',
      workspace,
      channels: [],
      error: {
        code,
        message: error instanceof Error ? error.message : 'Failed to load Slack channels',
      },
    };
  }
}
