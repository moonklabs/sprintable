
import { isExpiredIsoTimestamp, resolveMessagingBridgeSecretRef } from './slack-channel-mapping';
import { NotificationService } from './notification.service';

interface OrgAuthRow {
  org_id: string;
  access_token_ref: string;
  expires_at: string | null;
}

interface TeamMemberRecipientRow {
  id: string;
  user_id: string | null;
}

type Logger = Pick<Console, 'warn' | 'error'>;

const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default';
const BOT_FRAMEWORK_TOKEN_URL = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';

export interface TeamsBridgeConfig {
  botAppId: string | null;
}

export function resolveTeamsBridgeConfig(config: Record<string, string> | null | undefined, env: NodeJS.ProcessEnv = process.env): TeamsBridgeConfig {
  return {
    botAppId: resolveMessagingBridgeSecretRef(config?.bot_app_id, env),
  };
}

export async function getActiveTeamsOrgAuth(
  db: any,
  orgId: string,
): Promise<OrgAuthRow | null> {
  const { data, error } = await db
    .from('messaging_bridge_org_auths')
    .select('org_id, access_token_ref, expires_at')
    .eq('org_id', orgId)
    .eq('platform', 'teams')
    .maybeSingle();

  if (error) throw error;
  return (data as OrgAuthRow | null) ?? null;
}

export function resolveTeamsAppSecret(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env) {
  return resolveMessagingBridgeSecretRef(ref, env);
}

export function isTeamsAuthExpired(expiresAt: string | null | undefined, now = Date.now()) {
  return isExpiredIsoTimestamp(expiresAt, now);
}

async function listAdminRecipients(db: any, orgId: string): Promise<TeamMemberRecipientRow[]> {
  const { data: orgMembers, error: orgMembersError } = await db
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .in('role', ['owner', 'admin']);

  if (orgMembersError) throw orgMembersError;
  const userIds = (orgMembers ?? [])
    .map((row) => (row as { user_id?: string | null }).user_id ?? null)
    .filter((userId): userId is string => Boolean(userId));

  if (!userIds.length) return [];

  const { data: teamMembers, error: teamMembersError } = await db
    .from('team_members')
    .select('id, user_id')
    .eq('org_id', orgId)
    .eq('type', 'human')
    .eq('is_active', true)
    .in('user_id', userIds);

  if (teamMembersError) throw teamMembersError;
  const uniqueById = new Map<string, TeamMemberRecipientRow>();
  for (const member of teamMembers ?? []) {
    uniqueById.set(String((member as TeamMemberRecipientRow).id), member as TeamMemberRecipientRow);
  }
  return [...uniqueById.values()];
}

export async function notifyTeamsAuthFailed(
  db: any,
  orgId: string,
  reason: string,
) {
  const recipients = await listAdminRecipients(db, orgId);
  if (!recipients.length) return 0;

  const notifications = recipients.map((recipient) => ({
    org_id: orgId,
    user_id: recipient.id,
    type: 'warning' as const,
    title: 'Microsoft Teams bridge auth_failed',
    body: `Microsoft Teams 브릿지 인증이 유효하지 않아 처리가 중단된. reason=${reason}`,
    reference_type: 'integration',
  }));

  await new NotificationService(db).createMany(notifications);
  return notifications.length;
}

export async function fetchTeamsAppAccessToken(input: {
  botAppId: string;
  appSecret: string;
  fetchFn?: typeof fetch;
  logger?: Logger;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: input.botAppId,
    client_secret: input.appSecret,
    scope: BOT_FRAMEWORK_SCOPE,
  });

  const response = await fetchFn(BOT_FRAMEWORK_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const json = await response.json().catch(() => ({})) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !json.access_token) {
    const reason = json.error ?? json.error_description ?? `http_${response.status}`;
    input.logger?.warn?.(`[TeamsBridge] bot token fetch failed: ${reason}`);
    throw new Error(reason);
  }

  return json.access_token;
}
