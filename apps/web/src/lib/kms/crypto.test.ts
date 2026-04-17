import { beforeEach, describe, expect, it } from 'vitest';
import { decryptSecretForOrg, encryptSecretForOrg } from './crypto';

beforeEach(() => {
  process.env.KMS_PROVIDER = 'local';
  process.env.LOCAL_KMS_MASTER_KEY = 'unit-test-local-master-key';
});

describe('kms crypto', () => {
  it('round-trips a secret for the same org', async () => {
    const encrypted = await encryptSecretForOrg('org-1', 'sk-secret-value');
    expect(encrypted).not.toContain('sk-secret-value');

    const decrypted = await decryptSecretForOrg('org-1', encrypted);
    expect(decrypted).toBe('sk-secret-value');
  });

  it('rejects decrypting another org secret blob', async () => {
    const encrypted = await encryptSecretForOrg('org-1', 'sk-secret-value');
    await expect(decryptSecretForOrg('org-2', encrypted)).rejects.toThrow('organization');
  });
});
