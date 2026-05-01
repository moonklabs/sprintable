import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { KmsAdapter, KmsProvider, WrappedDekEnvelope } from './provider';
import { getKmsAdapter } from './provider';
import { KmsDecryptionError } from './errors';

interface EncryptedSecretEnvelope extends WrappedDekEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  kmsProvider: KmsProvider;
  orgId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function aadForOrg(orgId: string) {
  return Buffer.from(`org:${orgId}:byom-secret:v1`);
}

export async function encryptSecretForOrg(
  orgId: string,
  plaintextSecret: string,
  kmsAdapter: KmsAdapter = getKmsAdapter(),
): Promise<string> {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(plaintextSecret, 'utf8');

  try {
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(aadForOrg(orgId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const wrapped = await kmsAdapter.wrapDek(orgId, dek);

    const envelope: EncryptedSecretEnvelope = {
      version: 1,
      algorithm: 'aes-256-gcm',
      kmsProvider: kmsAdapter.provider,
      orgId,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      ...wrapped,
    };

    return JSON.stringify(envelope);
  } finally {
    dek.fill(0);
    plaintext.fill(0);
  }
}

export async function decryptSecretForOrg(
  orgId: string,
  encryptedSecret: string,
  kmsAdapter?: KmsAdapter,
): Promise<string> {
  const envelope = JSON.parse(encryptedSecret) as EncryptedSecretEnvelope;
  if (envelope.orgId !== orgId) {
    throw new KmsDecryptionError('Encrypted secret does not belong to this organization');
  }

  const adapter = kmsAdapter ?? getKmsAdapter(envelope.kmsProvider);
  const dek = await adapter.unwrapDek(orgId, envelope);
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(aadForOrg(orgId));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const secret = plaintext.toString('utf8');
    plaintext.fill(0);
    return secret;
  } catch {
    throw new KmsDecryptionError('Encrypted secret could not be decrypted');
  } finally {
    dek.fill(0);
    ciphertext.fill(0);
  }
}
