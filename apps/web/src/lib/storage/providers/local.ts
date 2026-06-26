import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { IStorageService, StorageObjectHead } from '@sprintable/core-storage';
import { localStorageConfig, resolveLocalSigningSecret } from '../config';
import { signLocalObject } from '../local-sign';

// E-STORAGE-SSOT S1 (D2): local disk provider. OSS zero-config 기본.
// signRead 는 sign 라우트(BE authorize 통과 후)가 발급하는 단기 HMAC capability URL 을
// serve 라우트(`/api/storage/local/...`)로 가리킨다(GCS V4 signed URL 동치).

export class LocalDiskStorageService implements IStorageService {
  constructor(
    private readonly root: string = localStorageConfig.root,
    // fail-closed: prod 에서 STORAGE_LOCAL_SIGNING_SECRET 미설정이면 생성 시점에 throw.
    private readonly signingSecret: string = resolveLocalSigningSecret(),
  ) {}

  // path traversal 차단: container/objectPath 를 root 아래로 정규화하고 이탈하면 거부.
  private resolveSafe(container: string, objectPath: string): string {
    const base = resolve(this.root, container);
    const target = resolve(base, objectPath);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error('local storage: path traversal blocked');
    }
    return target;
  }

  async putObject(
    container: string,
    objectPath: string,
    body: Buffer,
    _contentType?: string,
  ): Promise<{ url: string }> {
    const target = this.resolveSafe(container, objectPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    // bare object path → canonicalization no-op(GCS prefix 아님). 저장 메타에 그대로 보관.
    return { url: objectPath };
  }

  async signRead(
    container: string,
    objectPath: string,
    expiresInMs = 5 * 60 * 1000,
  ): Promise<string> {
    const exp = Date.now() + expiresInMs;
    const sig = signLocalObject(this.signingSecret, container, objectPath, exp);
    // same-origin 상대 URL — 브라우저가 직접 fetch. serve 라우트가 HMAC 검증.
    const qs = new URLSearchParams({ exp: String(exp), sig });
    return `/api/storage/local/${container}/${objectPath}?${qs.toString()}`;
  }

  async deleteObject(container: string, objectPath: string): Promise<void> {
    try {
      await unlink(this.resolveSafe(container, objectPath));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  async headObject(container: string, objectPath: string): Promise<StorageObjectHead | null> {
    try {
      const s = await stat(this.resolveSafe(container, objectPath));
      return { size: s.size, contentType: null };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  // serve 라우트가 파일 bytes 를 읽을 때 사용(HMAC 검증 후).
  async readObject(container: string, objectPath: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolveSafe(container, objectPath));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
}
