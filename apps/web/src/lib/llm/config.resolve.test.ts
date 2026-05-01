import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KmsServiceError } from '@/lib/kms';

const { createClientMock, getProjectAiSettingsWithIntegrationMock, ensureProjectSecretEncryptedMock, decryptProjectSecretMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  getProjectAiSettingsWithIntegrationMock: vi.fn(),
  ensureProjectSecretEncryptedMock: vi.fn(),
  decryptProjectSecretMock: vi.fn(),
}));

vi.mock('', () => ({
  createClient: createClientMock,
}));

vi.mock('./project-ai-settings', async () => {
  const actual = await vi.importActual<typeof import('./project-ai-settings')>('./project-ai-settings');
  return {
    ...actual,
    getProjectAiSettingsWithIntegration: getProjectAiSettingsWithIntegrationMock,
    ensureProjectSecretEncrypted: ensureProjectSecretEncryptedMock,
    decryptProjectSecret: decryptProjectSecretMock,
  };
});

import { resolveLLMConfig } from './config';
import { LLMAuthError } from './errors';

beforeEach(() => {
  vi.resetAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.GOOGLE_API_KEY = '';
  process.env.GROQ_API_KEY = '';
  process.env.OPENAI_COMPATIBLE_API_KEY = '';
  createClientMock.mockReturnValue({});
});

describe('resolveLLMConfig', () => {
  it('decrypts BYOM credentials from org_integrations', async () => {
    getProjectAiSettingsWithIntegrationMock.mockResolvedValue({
      settings: {
        org_id: 'org-1',
        provider: 'openai',
        llm_config: { model: 'gpt-4o-mini', perRunCapCents: 123 },
      },
      integration: { encrypted_secret: 'encrypted' },
    });
    ensureProjectSecretEncryptedMock.mockResolvedValue({ encrypted_secret: 'encrypted' });
    decryptProjectSecretMock.mockResolvedValue('sk-decrypted');

    const config = await resolveLLMConfig('project-1');

    expect(config).toMatchObject({
      provider: 'openai',
      billingMode: 'byom',
      apiKey: 'sk-decrypted',
      perRunCapCents: 123,
    });
  });

  it('respects managed deployment provider/model overrides instead of falling back to the first env key', async () => {
    getProjectAiSettingsWithIntegrationMock.mockResolvedValue({
      settings: {
        org_id: 'org-1',
        provider: 'openai',
        llm_config: { model: 'gpt-4o-mini' },
      },
      integration: null,
    });
    ensureProjectSecretEncryptedMock.mockResolvedValue(null);
    decryptProjectSecretMock.mockResolvedValue(null);
    process.env.OPENAI_API_KEY = 'sk-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic';

    const config = await resolveLLMConfig('project-1', {
      billingMode: 'managed',
      provider: 'anthropic',
      model: 'claude-opus-4',
    });

    expect(config).toMatchObject({
      billingMode: 'managed',
      provider: 'anthropic',
      model: 'claude-opus-4',
      apiKey: 'sk-anthropic',
    });
  });

  it('returns null for BYOM deployment overrides when no encrypted project credential exists', async () => {
    getProjectAiSettingsWithIntegrationMock.mockResolvedValue({
      settings: {
        org_id: 'org-1',
        provider: 'openai',
        llm_config: { model: 'gpt-4o-mini' },
      },
      integration: null,
    });
    ensureProjectSecretEncryptedMock.mockResolvedValue(null);
    decryptProjectSecretMock.mockResolvedValue(null);
    process.env.OPENAI_API_KEY = 'sk-openai';

    const config = await resolveLLMConfig('project-1', {
      billingMode: 'byom',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(config).toBeNull();
  });

  it('returns null for BYOM deployment overrides when the stored credential provider does not match', async () => {
    getProjectAiSettingsWithIntegrationMock.mockResolvedValue({
      settings: {
        org_id: 'org-1',
        provider: 'openai',
        llm_config: { model: 'gpt-4o-mini' },
      },
      integration: {
        provider: 'openai',
        encrypted_secret: 'encrypted',
      },
    });

    const config = await resolveLLMConfig('project-1', {
      billingMode: 'byom',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });

    expect(config).toBeNull();
    expect(ensureProjectSecretEncryptedMock).not.toHaveBeenCalled();
    expect(decryptProjectSecretMock).not.toHaveBeenCalled();
  });

  it('wraps KMS outages as a safe LLMAuthError', async () => {
    getProjectAiSettingsWithIntegrationMock.mockResolvedValue({
      settings: {
        org_id: 'org-1',
        provider: 'openai',
        llm_config: { model: 'gpt-4o-mini' },
      },
      integration: { encrypted_secret: 'encrypted' },
    });
    ensureProjectSecretEncryptedMock.mockRejectedValue(new KmsServiceError('vault down'));

    await expect(resolveLLMConfig('project-1')).rejects.toEqual(expect.objectContaining({
      name: 'LLMAuthError',
      message: 'KMS 서비스 일시 오류',
    } satisfies Partial<LLMAuthError>));
  });
});
