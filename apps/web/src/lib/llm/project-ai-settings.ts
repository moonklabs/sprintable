
import type { SupabaseClient } from '@/types/supabase';
import { decryptSecretForOrg, encryptSecretForOrg } from '@/lib/kms';

export const ORG_INTEGRATION_TYPE = 'byom_api_key';

export interface ProjectAiSettingsRecord {
  id?: string;
  org_id: string;
  project_id: string;
  provider: string;
  api_key?: string | null;
  llm_config?: unknown;
  created_at?: string;
  updated_at?: string;
}

export interface OrgIntegrationRecord {
  id?: string;
  org_id: string;
  project_id: string;
  integration_type: string;
  provider: string;
  secret_last4?: string | null;
  encrypted_secret?: string | null;
  kms_provider?: string | null;
  kms_status?: string | null;
  rotation_requested_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectAiCredentialState {
  settings: ProjectAiSettingsRecord | null;
  integration: OrgIntegrationRecord | null;
}

export function maskLast4(secretLast4?: string | null) {
  return secretLast4 ? `****${secretLast4}` : null;
}

export function hasProjectAiCredential(payload: ProjectAiCredentialState) {
  return Boolean(payload.integration?.encrypted_secret || payload.integration?.secret_last4 || payload.settings?.api_key);
}

export function resolveProjectAiCredentialProvider(payload: ProjectAiCredentialState): string | null {
  const integrationProvider = payload.integration?.provider?.trim();
  if (integrationProvider) return integrationProvider;

  const settingsProvider = payload.settings?.provider?.trim();
  return settingsProvider || null;
}

export function matchesProjectAiCredentialProvider(payload: ProjectAiCredentialState, provider: string) {
  const normalizedProvider = provider.trim();
  if (!normalizedProvider || !hasProjectAiCredential(payload)) return false;

  const settingsProvider = payload.settings?.provider?.trim();
  if (settingsProvider && settingsProvider !== normalizedProvider) return false;

  const integrationProvider = payload.integration?.provider?.trim();
  if (integrationProvider && integrationProvider !== normalizedProvider) return false;

  return true;
}

export async function getProjectAiSettingsWithIntegration(
  db: SupabaseClient,
  projectId: string,
): Promise<ProjectAiCredentialState> {
  const [{ data: settings, error: settingsError }, { data: integration, error: integrationError }] = await Promise.all([
    db
      .from('project_ai_settings')
      .select('id, org_id, project_id, provider, api_key, llm_config, created_at, updated_at')
      .eq('project_id', projectId)
      .maybeSingle(),
    db
      .from('org_integrations')
      .select('id, org_id, project_id, integration_type, provider, secret_last4, encrypted_secret, kms_provider, kms_status, rotation_requested_at, created_at, updated_at')
      .eq('project_id', projectId)
      .eq('integration_type', ORG_INTEGRATION_TYPE)
      .maybeSingle(),
  ]);

  if (settingsError) throw settingsError;
  if (integrationError) throw integrationError;

  return {
    settings: (settings ?? null) as ProjectAiSettingsRecord | null,
    integration: (integration ?? null) as OrgIntegrationRecord | null,
  };
}

export async function upsertEncryptedProjectSecret(
  db: SupabaseClient,
  input: {
    orgId: string;
    projectId: string;
    provider: string;
    plaintextSecret: string;
    updatedAt?: string;
  },
) {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const encryptedSecret = await encryptSecretForOrg(input.orgId, input.plaintextSecret);

  const { error: integrationError } = await db
    .from('org_integrations')
    .upsert({
      org_id: input.orgId,
      project_id: input.projectId,
      integration_type: ORG_INTEGRATION_TYPE,
      provider: input.provider,
      secret_last4: input.plaintextSecret.slice(-4),
      encrypted_secret: encryptedSecret,
      kms_provider: process.env.KMS_PROVIDER ?? 'local',
      kms_status: 'active',
      rotation_requested_at: null,
      updated_at: updatedAt,
    }, { onConflict: 'project_id,integration_type' });

  if (integrationError) throw integrationError;

  const { error: settingsError } = await db
    .from('project_ai_settings')
    .update({ api_key: null, updated_at: updatedAt })
    .eq('project_id', input.projectId);

  if (settingsError) throw settingsError;

  return { encryptedSecret, updatedAt };
}

export async function persistProjectAiSettingsWithEncryptedSecret(
  db: SupabaseClient,
  input: {
    orgId: string;
    projectId: string;
    provider: string;
    llmConfig: unknown;
    plaintextSecret: string;
    updatedAt?: string;
  },
) {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const encryptedSecret = await encryptSecretForOrg(input.orgId, input.plaintextSecret);
  const { data, error } = await db.rpc('upsert_project_ai_settings_with_secret', {
    p_org_id: input.orgId,
    p_project_id: input.projectId,
    p_provider: input.provider,
    p_llm_config: input.llmConfig ?? {},
    p_encrypted_secret: encryptedSecret,
    p_secret_last4: input.plaintextSecret.slice(-4),
    p_kms_provider: process.env.KMS_PROVIDER ?? 'local',
    p_updated_at: updatedAt,
  });

  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { data: row, encryptedSecret, updatedAt };
}

export async function decryptProjectSecret(
  orgId: string,
  integration: Pick<OrgIntegrationRecord, 'encrypted_secret'>,
) {
  if (!integration.encrypted_secret) return null;
  return decryptSecretForOrg(orgId, integration.encrypted_secret);
}

export async function ensureProjectSecretEncrypted(
  db: SupabaseClient,
  payload: {
    settings: ProjectAiSettingsRecord | null;
    integration: OrgIntegrationRecord | null;
  },
) {
  if (payload.integration?.encrypted_secret) return payload.integration;
  if (!payload.settings?.org_id || !payload.settings?.api_key) return payload.integration;

  await upsertEncryptedProjectSecret(db, {
    orgId: payload.settings.org_id,
    projectId: payload.settings.project_id,
    provider: payload.settings.provider,
    plaintextSecret: payload.settings.api_key,
  });

  const { integration } = await getProjectAiSettingsWithIntegration(db, payload.settings.project_id);
  return integration;
}
