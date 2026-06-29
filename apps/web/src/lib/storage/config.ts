// E-STORAGE-SSOT S1: storage provider 선택 + 버킷/컨테이너 설정 SSOT.
//
// ⚠️ 배포 전제(PO lane·DoD): 기존 GCS 배포(dev/prod)는 ee unbuilt OSS apps/web 이미지로 단독
// 구동되므로 `registerStorageService()` 가 불리지 않는다. 따라서 GCS 를 쓰려면 **반드시
// `STORAGE_PROVIDER=gcs` env 를 명시**해야 한다(미설정 시 default `local` → 첨부가 ephemeral
// 디스크에 쓰여 GCS 무회귀 위반·인스턴스 리사이클 시 유실). prod/dev env provisioning 은
// S1 머지/승격과 원자적으로 처리(PO).

/** 선택된 storage provider. OSS 기본 = local(zero-config). GCS 배포는 'gcs' 명시 필수.
 *  미설정/공백 → local(zero-config 보존). 인식 못 하는 값은 팩토리가 fail-closed(throw)한다
 *  (오타 `gcx` 등이 silent local 추락→첨부 ephemeral 적재 data-loss로 가는 것 방지). */
export const STORAGE_PROVIDER =
  (process.env['STORAGE_PROVIDER'] ?? '').trim().toLowerCase() || 'local';

/** chat/story 첨부 컨테이너(GCS=버킷·s3=버킷·local=루트 하위 서브디렉터리). */
export const GCS_MEMO_ATTACHMENTS_BUCKET =
  process.env['GCS_MEMO_ATTACHMENTS_BUCKET'] ?? 'sprintable-memo-attachments';

/** 미팅 녹음 컨테이너(현 라우트는 BE 프록시 경유·여기선 호환 export 유지). */
export const GCS_RECORDINGS_BUCKET =
  process.env['GCS_RECORDINGS_BUCKET'] ?? 'sprintable-recordings';

/** local disk provider 설정. zero-config OSS 기본값. */
export const localStorageConfig = {
  /** 객체 루트. 컨테이너별 서브디렉터리가 그 아래에 생긴다. */
  root: process.env['STORAGE_LOCAL_ROOT'] ?? '.storage',
};

// dev-only 편의 기본(zero-config). prod 에서는 절대 사용하지 않는다(아래 fail-closed).
const _LOCAL_DEV_SECRET = 'sprintable-local-dev-unsafe';

/**
 * local provider HMAC 서명 비밀 resolve — **fail-closed**.
 * 미설정 + production(NODE_ENV) 이면 throw(공개 소스 기본값으로 HMAC 위조→authorize 우회 차단).
 * dev/test 에서는 미설정 시 dev 기본값으로 zero-config 유지. provider=local 경로에서만 호출된다.
 */
export function resolveLocalSigningSecret(): string {
  const s = (process.env['STORAGE_LOCAL_SIGNING_SECRET'] ?? '').trim();
  if (s) return s;
  if ((process.env['NODE_ENV'] ?? '').toLowerCase() === 'production') {
    throw new Error(
      'STORAGE_LOCAL_SIGNING_SECRET is required when STORAGE_PROVIDER=local in production',
    );
  }
  return _LOCAL_DEV_SECRET;
}

/** s3/minio provider 설정. provider=s3 일 때만 사용(SDK 는 dynamic import 로 분리). */
export const s3StorageConfig = {
  region: process.env['S3_REGION'] ?? 'us-east-1',
  /** minio/호환 스토리지용 endpoint override. 비면 AWS S3 기본. */
  endpoint: process.env['S3_ENDPOINT'] || undefined,
  accessKeyId: process.env['S3_ACCESS_KEY_ID'] || undefined,
  secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] || undefined,
  /** minio 는 path-style 필요. endpoint 설정 시 자동 path-style. */
  forcePathStyle: (process.env['S3_FORCE_PATH_STYLE'] ?? '').toLowerCase() === 'true' || !!process.env['S3_ENDPOINT'],
};
