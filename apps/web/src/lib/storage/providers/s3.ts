import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { IStorageService, StorageObjectHead } from '@sprintable/core-storage';
import { s3StorageConfig } from '../config';

// E-STORAGE-SSOT S1: S3(및 minio 호환) provider. @aws-sdk 는 팩토리에서 provider=s3 일 때만
// dynamic import 되므로 local/GCS 유저 번들 비용 0. minio = S3_ENDPOINT override + path-style.
// 범위 = AC2 "동작"까지(prod 미가동).

export class S3StorageService implements IStorageService {
  private _client: S3Client | null = null;

  // lazy: 인스턴스화만으로 client 를 구성하지 않는다(GCS provider 와 동일 계약).
  private get client(): S3Client {
    if (!this._client) {
      this._client = new S3Client({
        region: s3StorageConfig.region,
        ...(s3StorageConfig.endpoint ? { endpoint: s3StorageConfig.endpoint } : {}),
        forcePathStyle: s3StorageConfig.forcePathStyle,
        ...(s3StorageConfig.accessKeyId && s3StorageConfig.secretAccessKey
          ? {
              credentials: {
                accessKeyId: s3StorageConfig.accessKeyId,
                secretAccessKey: s3StorageConfig.secretAccessKey,
              },
            }
          : {}),
      });
    }
    return this._client;
  }

  async putObject(
    container: string,
    objectPath: string,
    body: Buffer,
    contentType?: string,
  ): Promise<{ url: string }> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: container,
        Key: objectPath,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
    // bare object path → canonicalization no-op. read 는 signRead(presigned)로만 노출.
    return { url: objectPath };
  }

  async signRead(
    container: string,
    objectPath: string,
    expiresInMs = 5 * 60 * 1000,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: container, Key: objectPath }),
      { expiresIn: Math.ceil(expiresInMs / 1000) },
    );
  }

  async deleteObject(container: string, objectPath: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: container, Key: objectPath }));
  }

  async headObject(container: string, objectPath: string): Promise<StorageObjectHead | null> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: container, Key: objectPath }),
      );
      return { size: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw e;
    }
  }
}
