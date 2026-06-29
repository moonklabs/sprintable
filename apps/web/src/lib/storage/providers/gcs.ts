import { Storage } from '@google-cloud/storage';
import type { IStorageService, SignReadOptions, StorageObjectHead } from '@sprintable/core-storage';

// E-STORAGE-SSOT S1: GCS provider. `@google-cloud/storage` 직 import 는 이 파일에만 격리된다
// (AC1: call-site 직 import 0). 로직은 기존 `lib/gcs.ts`(uploadToGcs/getSignedReadUrl)에서 이관.

function buildStorage(): Storage {
  const credsJson = process.env['GCS_CREDENTIALS_JSON'];
  if (credsJson) {
    return new Storage({
      projectId: process.env['GCS_PROJECT_ID'],
      credentials: JSON.parse(credsJson),
    });
  }
  // Workload Identity / ADC fallback (Cloud Run runtime SA).
  return new Storage({ projectId: process.env['GCS_PROJECT_ID'] });
}

export class GcsStorageService implements IStorageService {
  private _storage: Storage | null = null;

  // lazy: 인스턴스화만으로 SDK client 를 구성하지 않는다(팩토리 셀렉션·테스트 부작용 0).
  private get storage(): Storage {
    if (!this._storage) this._storage = buildStorage();
    return this._storage;
  }

  async putObject(
    container: string,
    objectPath: string,
    body: Buffer,
    contentType?: string,
  ): Promise<{ url: string }> {
    await this.storage.bucket(container).file(objectPath).save(body, {
      metadata: contentType ? { contentType } : undefined,
      resumable: false,
    });
    // legacy 호환: 기존 저장 포맷(public https URL)을 그대로 유지 — sign/authorize canonicalization 정합.
    return { url: `https://storage.googleapis.com/${container}/${objectPath}` };
  }

  async signRead(
    container: string,
    objectPath: string,
    opts?: SignReadOptions,
  ): Promise<string> {
    const expiresInMs = opts?.expiresInMs ?? 5 * 60 * 1000;
    const [url] = await this.storage
      .bucket(container)
      .file(objectPath)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + expiresInMs,
        ...(opts?.disposition ? { responseDisposition: opts.disposition } : {}),
      });
    return url;
  }

  async deleteObject(container: string, objectPath: string): Promise<void> {
    await this.storage.bucket(container).file(objectPath).delete({ ignoreNotFound: true });
  }

  async headObject(container: string, objectPath: string): Promise<StorageObjectHead | null> {
    const file = this.storage.bucket(container).file(objectPath);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [md] = await file.getMetadata();
    return {
      size: typeof md.size === 'string' ? Number(md.size) : (md.size ?? 0),
      contentType: md.contentType ?? null,
    };
  }
}
