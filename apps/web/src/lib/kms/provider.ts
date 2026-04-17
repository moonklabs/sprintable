import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { KmsConfigurationError, KmsDecryptionError, KmsServiceError } from './errors';

export type KmsProvider = 'local' | 'gcp' | 'vault';

export interface WrappedDekEnvelope {
  wrappedDek: string;
  keyVersion: string;
  wrappedDekIv?: string;
  wrappedDekTag?: string;
}

export interface KmsRotationResult {
  provider: KmsProvider;
  rotatedKeyVersion: string;
  executedAt: string;
}

export interface KmsAdapter {
  provider: KmsProvider;
  wrapDek(orgId: string, dek: Buffer): Promise<WrappedDekEnvelope>;
  unwrapDek(orgId: string, envelope: WrappedDekEnvelope): Promise<Buffer>;
  rotateOrgKey(orgId: string): Promise<KmsRotationResult>;
}

function normalizeMasterKey(secret: string): Buffer {
  try {
    const trimmed = secret.trim();
    if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
    const base64 = Buffer.from(trimmed, 'base64');
    if (base64.length === 32) return base64;
    return createHash('sha256').update(trimmed).digest();
  } catch {
    throw new KmsConfigurationError('LOCAL_KMS_MASTER_KEY is invalid');
  }
}

class LocalKmsAdapter implements KmsAdapter {
  readonly provider = 'local' as const;
  private readonly masterKey: Buffer;

  constructor(secret = process.env.LOCAL_KMS_MASTER_KEY) {
    if (!secret) throw new KmsConfigurationError('LOCAL_KMS_MASTER_KEY is required when KMS_PROVIDER=local');
    this.masterKey = normalizeMasterKey(secret);
  }

  private deriveOrgKey(orgId: string): Buffer {
    return createHmac('sha256', this.masterKey).update(`org:${orgId}:dek:v1`).digest();
  }

  async wrapDek(orgId: string, dek: Buffer): Promise<WrappedDekEnvelope> {
    const orgKey = this.deriveOrgKey(orgId);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', orgKey, iv);
    cipher.setAAD(Buffer.from(`org:${orgId}:dek:v1`));
    const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    orgKey.fill(0);
    return {
      wrappedDek: wrapped.toString('base64'),
      wrappedDekIv: iv.toString('base64'),
      wrappedDekTag: tag.toString('base64'),
      keyVersion: 'local-v1',
    };
  }

  async unwrapDek(orgId: string, envelope: WrappedDekEnvelope): Promise<Buffer> {
    if (!envelope.wrappedDekIv || !envelope.wrappedDekTag) {
      throw new KmsDecryptionError('Local KMS payload is incomplete');
    }
    const orgKey = this.deriveOrgKey(orgId);
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        orgKey,
        Buffer.from(envelope.wrappedDekIv, 'base64'),
      );
      decipher.setAAD(Buffer.from(`org:${orgId}:dek:v1`));
      decipher.setAuthTag(Buffer.from(envelope.wrappedDekTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.wrappedDek, 'base64')),
        decipher.final(),
      ]);
    } catch {
      throw new KmsDecryptionError('Local KMS decryption failed');
    } finally {
      orgKey.fill(0);
    }
  }

  async rotateOrgKey(orgId: string): Promise<KmsRotationResult> {
    const executedAt = new Date().toISOString();
    return {
      provider: this.provider,
      rotatedKeyVersion: `local-${createHash('sha256').update(`${orgId}:${executedAt}`).digest('hex').slice(0, 16)}`,
      executedAt,
    };
  }
}

class GcpKmsAdapter implements KmsAdapter {
  readonly provider = 'gcp' as const;
  private readonly keyName: string;
  private readonly bearerToken: string;

  constructor(
    keyName = process.env.GCP_KMS_KEY_NAME,
    bearerToken = process.env.GCP_KMS_BEARER_TOKEN,
  ) {
    if (!keyName || !bearerToken) {
      throw new KmsConfigurationError('GCP_KMS_KEY_NAME and GCP_KMS_BEARER_TOKEN are required when KMS_PROVIDER=gcp');
    }
    this.keyName = keyName;
    this.bearerToken = bearerToken;
  }

  async wrapDek(orgId: string, dek: Buffer): Promise<WrappedDekEnvelope> {
    try {
      const res = await fetch(`https://cloudkms.googleapis.com/v1/${this.keyName}:encrypt`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plaintext: dek.toString('base64'),
          additionalAuthenticatedData: Buffer.from(`org:${orgId}`).toString('base64'),
        }),
      });
      if (!res.ok) throw new Error(`gcp_encrypt_${res.status}`);
      const data = await res.json() as { ciphertext?: string; name?: string };
      if (!data.ciphertext) throw new Error('gcp_encrypt_missing_ciphertext');
      return {
        wrappedDek: data.ciphertext,
        keyVersion: data.name ?? this.keyName,
      };
    } catch {
      throw new KmsServiceError('GCP KMS encrypt failed');
    }
  }

  async unwrapDek(orgId: string, envelope: WrappedDekEnvelope): Promise<Buffer> {
    try {
      const res = await fetch(`https://cloudkms.googleapis.com/v1/${this.keyName}:decrypt`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ciphertext: envelope.wrappedDek,
          additionalAuthenticatedData: Buffer.from(`org:${orgId}`).toString('base64'),
        }),
      });
      if (!res.ok) throw new Error(`gcp_decrypt_${res.status}`);
      const data = await res.json() as { plaintext?: string };
      if (!data.plaintext) throw new Error('gcp_decrypt_missing_plaintext');
      return Buffer.from(data.plaintext, 'base64');
    } catch {
      throw new KmsServiceError('GCP KMS decrypt failed');
    }
  }

  async rotateOrgKey(_orgId: string): Promise<KmsRotationResult> {
    const executedAt = new Date().toISOString();
    try {
      const res = await fetch(`https://cloudkms.googleapis.com/v1/${this.keyName}/cryptoKeyVersions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!res.ok) throw new Error(`gcp_rotate_${res.status}`);
      const data = await res.json() as { name?: string };
      return {
        provider: this.provider,
        rotatedKeyVersion: data.name ?? this.keyName,
        executedAt,
      };
    } catch {
      throw new KmsServiceError('GCP KMS rotation failed');
    }
  }
}

class VaultKmsAdapter implements KmsAdapter {
  readonly provider = 'vault' as const;
  private readonly addr: string;
  private readonly token: string;
  private readonly transitKey: string;

  constructor(
    addr = process.env.VAULT_ADDR,
    token = process.env.VAULT_TOKEN,
    transitKey = process.env.VAULT_TRANSIT_KEY ?? 'sprintable-byom',
  ) {
    if (!addr || !token) {
      throw new KmsConfigurationError('VAULT_ADDR and VAULT_TOKEN are required when KMS_PROVIDER=vault');
    }
    this.addr = addr.replace(/\/$/, '');
    this.token = token;
    this.transitKey = transitKey;
  }

  async wrapDek(orgId: string, dek: Buffer): Promise<WrappedDekEnvelope> {
    try {
      const res = await fetch(`${this.addr}/v1/transit/encrypt/${this.transitKey}`, {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plaintext: dek.toString('base64'),
          context: Buffer.from(`org:${orgId}`).toString('base64'),
        }),
      });
      if (!res.ok) throw new Error(`vault_encrypt_${res.status}`);
      const data = await res.json() as { data?: { ciphertext?: string; key_version?: number } };
      if (!data.data?.ciphertext) throw new Error('vault_encrypt_missing_ciphertext');
      return {
        wrappedDek: data.data.ciphertext,
        keyVersion: String(data.data.key_version ?? 'vault-v1'),
      };
    } catch {
      throw new KmsServiceError('Vault transit encrypt failed');
    }
  }

  async unwrapDek(orgId: string, envelope: WrappedDekEnvelope): Promise<Buffer> {
    try {
      const res = await fetch(`${this.addr}/v1/transit/decrypt/${this.transitKey}`, {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ciphertext: envelope.wrappedDek,
          context: Buffer.from(`org:${orgId}`).toString('base64'),
        }),
      });
      if (!res.ok) throw new Error(`vault_decrypt_${res.status}`);
      const data = await res.json() as { data?: { plaintext?: string } };
      if (!data.data?.plaintext) throw new Error('vault_decrypt_missing_plaintext');
      return Buffer.from(data.data.plaintext, 'base64');
    } catch {
      throw new KmsServiceError('Vault transit decrypt failed');
    }
  }

  async rotateOrgKey(_orgId: string): Promise<KmsRotationResult> {
    const executedAt = new Date().toISOString();
    try {
      const res = await fetch(`${this.addr}/v1/transit/keys/${this.transitKey}/rotate`, {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!res.ok) throw new Error(`vault_rotate_${res.status}`);
      const data = await res.json() as { data?: { latest_version?: number } };
      return {
        provider: this.provider,
        rotatedKeyVersion: String(data.data?.latest_version ?? 'vault-rotated'),
        executedAt,
      };
    } catch {
      throw new KmsServiceError('Vault transit rotation failed');
    }
  }
}

export function getKmsAdapter(provider = (process.env.KMS_PROVIDER as KmsProvider | undefined) ?? 'local'): KmsAdapter {
  if (provider === 'local') return new LocalKmsAdapter();
  if (provider === 'gcp') return new GcpKmsAdapter();
  if (provider === 'vault') return new VaultKmsAdapter();
  throw new KmsConfigurationError(`Unsupported KMS provider: ${provider}`);
}
