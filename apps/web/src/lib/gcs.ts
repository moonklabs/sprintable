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

export const GCS_MEMO_ATTACHMENTS_BUCKET =
  process.env['GCS_MEMO_ATTACHMENTS_BUCKET'] ?? 'sprintable-memo-attachments';

export const GCS_RECORDINGS_BUCKET =
  process.env['GCS_RECORDINGS_BUCKET'] ?? 'sprintable-recordings';
