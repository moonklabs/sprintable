
import type { SupabaseClient } from '@/types/supabase';
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

export function resolveDiscordToken(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env) {
  return resolveMessagingBridgeSecretRef(ref, env);
}

export function isDiscordAuthExpired(expiresAt: string | null | undefined, now = Date.now()) {
  return isExpiredIsoTimestamp(expiresAt, now);
}

export async function getActiveDiscordOrgAuth(
  db: SupabaseClient,
  orgId: string,
): Promise<OrgAuthRow | null> {
  const { data, error } = await db
    .from('messaging_bridge_org_auths')
    .select('org_id, access_token_ref, expires_at')
    .eq('org_id', orgId)
    .eq('platform', 'discord')
    .maybeSingle();

  if (error) throw error;
  return (data as OrgAuthRow | null) ?? null;
}

export async function listAdminRecipients(db: SupabaseClient, orgId: string): Promise<TeamMemberRecipientRow[]> {
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

export async function notifyDiscordAuthFailed(
  db: SupabaseClient,
  orgId: string,
  reason: string,
) {
  const recipients = await listAdminRecipients(db, orgId);
  if (!recipients.length) return 0;

  const notifications = recipients.map((recipient) => ({
    org_id: orgId,
    user_id: recipient.id,
    type: 'warning' as const,
    title: 'Discord bridge auth_failed',
    body: `Discord 브릿지 인증이 유효하지 않아 처리가 중단된. reason=${reason}`,
    reference_type: 'integration',
  }));

  await new NotificationService(db).createMany(notifications);
  return notifications.length;
}
