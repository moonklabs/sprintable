import { Storage } from '@google-cloud/storage';

function buildStorage(): Storage {
  const credsJson = process.env['GCS_CREDENTIALS_JSON'];
  if (credsJson) {
    return new Storage({
      projectId: process.env['GCS_PROJECT_ID'],
      credentials: JSON.parse(credsJson),
    });
  }
  // Workload Identity / ADC fallback
  return new Storage({ projectId: process.env['GCS_PROJECT_ID'] });
}

let _storage: Storage | null = null;
function getStorage(): Storage {
  if (!_storage) _storage = buildStorage();
  return _storage;
}

export async function uploadToGcs(
  bucketName: string,
  filePath: string,
  file: File,
): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const bucket = getStorage().bucket(bucketName);
  await bucket.file(filePath).save(buffer, {
    metadata: { contentType: file.type },
    resumable: false,
  });
  return `https://storage.googleapis.com/${bucketName}/${filePath}`;
}

/**
 * a54ddc16: 단기 만료 V4 read 서명 URL 생성. public 버킷 → auth-gated 서빙 전환의 일부로,
 * authorize 통과 후에만 호출한다(서명 라우트 `/api/attachments/sign`). path 는 bare object path.
 */
export async function getSignedReadUrl(
  bucketName: string,
  objectPath: string,
  expiresInMs = 5 * 60 * 1000,
): Promise<string> {
  const [url] = await getStorage()
    .bucket(bucketName)
    .file(objectPath)
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresInMs,
    });
  return url;
}

export const GCS_MEMO_ATTACHMENTS_BUCKET =
  process.env['GCS_MEMO_ATTACHMENTS_BUCKET'] ?? 'sprintable-memo-attachments';

export const GCS_RECORDINGS_BUCKET =
  process.env['GCS_RECORDINGS_BUCKET'] ?? 'sprintable-recordings';
