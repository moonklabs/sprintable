/**
 * E-STORAGE-SSOT S1: blob 스토리지 단일 추상(SSOT).
 *
 * provider(gcs|s3|minio|local)별 구현을 이 계약 뒤로 숨긴다. call-site(업로드·서명 라우트)는
 * provider SDK(`@google-cloud/storage`, `@aws-sdk/*` 등)를 직접 import 하지 않는다(AC1).
 * 구현체는 무거운 런타임 의존을 들고 있어 앱 런타임(`apps/web/src/lib/storage/providers`)에
 * 두고, 계약(이 파일)만 dep-light 한 core-storage 에 둔다(3층 레이어링 정합).
 */

/** headObject 결과 — 객체 메타. */
export interface StorageObjectHead {
  /** 객체 바이트 크기. */
  size: number;
  /** 저장 시 기록된 content-type. 미기록이면 null. */
  contentType: string | null;
}

export interface IStorageService {
  /**
   * 객체 업로드. 반환 `url` 은 첨부 메타에 저장되는 canonical 값으로, sign/authorize 경로의
   * canonicalization 규칙과 정합해야 한다.
   * - GCS: legacy 호환을 위해 public https URL(`https://storage.googleapis.com/{container}/{path}`).
   * - local/s3: bare object path(스킴 없음 → canonicalization no-op·동일 규칙으로 서명 라우트가 소비).
   */
  putObject(
    container: string,
    objectPath: string,
    body: Buffer,
    contentType?: string,
  ): Promise<{ url: string }>;

  /** authorize 통과 후 호출되는 단기 만료 read 서명 URL. */
  signRead(container: string, objectPath: string, expiresInMs?: number): Promise<string>;

  /** 객체 삭제. 객체가 없으면 no-op. */
  deleteObject(container: string, objectPath: string): Promise<void>;

  /** 객체 메타 조회. 객체가 없으면 null. */
  headObject(container: string, objectPath: string): Promise<StorageObjectHead | null>;
}
