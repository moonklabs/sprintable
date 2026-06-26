import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signLocalObject, verifyLocalObject } from './local-sign';
import { LocalDiskStorageService } from './providers/local';

// E-STORAGE-SSOT S1 — provider 추상 + 팩토리 셀렉션 + local roundtrip.

describe('local-sign HMAC', () => {
  const secret = 'unit-secret';
  const container = 'sprintable-memo-attachments';
  const path = 'chat/p1/c1/abc-file.png';

  it('서명→검증 통과', () => {
    const exp = Date.now() + 60_000;
    const sig = signLocalObject(secret, container, path, exp);
    expect(verifyLocalObject(secret, container, path, exp, sig)).toBe(true);
  });

  it('만료된 exp → 거부', () => {
    const exp = Date.now() - 1;
    const sig = signLocalObject(secret, container, path, exp);
    expect(verifyLocalObject(secret, container, path, exp, sig)).toBe(false);
  });

  it('변조된 sig → 거부', () => {
    const exp = Date.now() + 60_000;
    expect(verifyLocalObject(secret, container, path, exp, 'deadbeef')).toBe(false);
  });

  it('다른 path 로 서명 검증 → 거부(객체 바인딩)', () => {
    const exp = Date.now() + 60_000;
    const sig = signLocalObject(secret, container, path, exp);
    expect(verifyLocalObject(secret, container, 'chat/p1/c1/other.png', exp, sig)).toBe(false);
  });
});

describe('LocalDiskStorageService roundtrip', () => {
  let root: string;
  let svc: LocalDiskStorageService;
  const container = 'sprintable-memo-attachments';
  const objectPath = 'chat/proj/conv/uuid-hello.txt';
  const secret = 'unit-secret';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sp-storage-'));
    svc = new LocalDiskStorageService(root, secret);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('put → head → read → signRead → delete', async () => {
    const body = Buffer.from('hello storage', 'utf8');
    const { url } = await svc.putObject(container, objectPath, body, 'text/plain');
    // bare path 저장(canonicalization no-op)
    expect(url).toBe(objectPath);

    const head = await svc.headObject(container, objectPath);
    expect(head).not.toBeNull();
    expect(head?.size).toBe(body.length);

    const read = await svc.readObject(container, objectPath);
    expect(read?.toString('utf8')).toBe('hello storage');

    const signed = await svc.signRead(container, objectPath, { expiresInMs: 60_000 });
    expect(signed).toContain(`/api/storage/local/${container}/${objectPath}`);
    const u = new URL(signed, 'http://localhost');
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig') ?? '';
    expect(verifyLocalObject(secret, container, objectPath, exp, sig)).toBe(true);

    await svc.deleteObject(container, objectPath);
    expect(await svc.headObject(container, objectPath)).toBeNull();
  });

  it('없는 객체 head → null', async () => {
    expect(await svc.headObject(container, 'missing/x')).toBeNull();
  });

  it('path traversal 차단', async () => {
    await expect(
      svc.putObject(container, '../../escape.txt', Buffer.from('x')),
    ).rejects.toThrow(/traversal/);
  });
});

describe('createStorageService 셀렉션', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('register 우선(미래 ee seam)', async () => {
    vi.resetModules();
    const { createStorageService, registerStorageService } = await import('./factory');
    const sentinel = { tag: 'sentinel' } as unknown;
    registerStorageService(async () => sentinel as never);
    expect(await createStorageService()).toBe(sentinel);
  });

  it('STORAGE_PROVIDER 미설정 → local 기본', async () => {
    vi.resetModules();
    vi.stubEnv('STORAGE_PROVIDER', '');
    const { createStorageService } = await import('./factory');
    const { LocalDiskStorageService: Local } = await import('./providers/local');
    expect(await createStorageService()).toBeInstanceOf(Local);
  });

  it('STORAGE_PROVIDER=gcs → GcsStorageService', async () => {
    vi.resetModules();
    vi.stubEnv('STORAGE_PROVIDER', 'gcs');
    const { createStorageService } = await import('./factory');
    const { GcsStorageService } = await import('./providers/gcs');
    expect(await createStorageService()).toBeInstanceOf(GcsStorageService);
  });

  it('STORAGE_PROVIDER=s3 → S3StorageService', async () => {
    vi.resetModules();
    vi.stubEnv('STORAGE_PROVIDER', 's3');
    const { createStorageService } = await import('./factory');
    const { S3StorageService } = await import('./providers/s3');
    expect(await createStorageService()).toBeInstanceOf(S3StorageService);
  });

  it('미인식 STORAGE_PROVIDER → fail-closed throw (silent local 추락 금지)', async () => {
    vi.resetModules();
    vi.stubEnv('STORAGE_PROVIDER', 'gcx');
    const { createStorageService } = await import('./factory');
    await expect(createStorageService()).rejects.toThrow(/unknown STORAGE_PROVIDER/);
  });
});

describe('resolveLocalSigningSecret fail-closed', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('secret 설정 시 그 값 반환', async () => {
    vi.resetModules();
    vi.stubEnv('STORAGE_LOCAL_SIGNING_SECRET', 'prod-secret');
    vi.stubEnv('NODE_ENV', 'production');
    const { resolveLocalSigningSecret } = await import('./config');
    expect(resolveLocalSigningSecret()).toBe('prod-secret');
  });

  it('production + 미설정 → throw', async () => {
    vi.resetModules();
    vi.stubEnv('STORAGE_LOCAL_SIGNING_SECRET', '');
    vi.stubEnv('NODE_ENV', 'production');
    const { resolveLocalSigningSecret } = await import('./config');
    expect(() => resolveLocalSigningSecret()).toThrow(/required.*production/);
  });

  it('dev + 미설정 → dev 기본(zero-config)', async () => {
    vi.resetModules();
    vi.stubEnv('STORAGE_LOCAL_SIGNING_SECRET', '');
    vi.stubEnv('NODE_ENV', 'development');
    const { resolveLocalSigningSecret } = await import('./config');
    expect(resolveLocalSigningSecret()).toBe('sprintable-local-dev-unsafe');
  });
});
