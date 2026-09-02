import { fetchWithAuth } from '@/lib/db/client';
import type { Asset } from '@/lib/storage/types';

// story #886d996f(업로드 축) — manual 자산 업로드 3단 흐름. BE(#3249)의 SSOT 프리사인드 계약을
// 소비: upload-url(서버-구성 object_path+서명 PUT URL) → 브라우저 직접 PUT(GCS) → upload-confirm
// (head_object 실측 후 Asset 등록). 자체 서명/putObject 0. avatar-upload.ts와 동형 원칙이되,
// PUT에 Content-Type뿐 아니라 required_put_headers(x-goog-if-generation-match: 0)도 실어야 한다
// (둘 다 서명에 baked — 누락 시 GCS 403).

interface UploadUrlResponse {
  upload_url: string;
  object_path: string;
  expires_at: string;
  required_put_headers: Record<string, string>;
}

async function requestUploadUrl(filename: string, contentType: string, projectId: string): Promise<UploadUrlResponse> {
  const res = await fetchWithAuth('/api/assets/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content_type: contentType, project_id: projectId }),
  });
  if (!res.ok) throw new Error(`upload-url failed: ${res.status}`);
  const json = (await res.json()) as { data: UploadUrlResponse };
  return json.data;
}

// GCS 직접 PUT — 서명에 baked된 Content-Type과 required_put_headers(x-goog-if-generation-match:0)를
// 그대로 실어야 서명이 맞는다. required_put_headers는 «하드코딩 말고 응답을 그대로 순회»(BE 요구).
// fetchWithAuth 인터셉터(X-Project-Id 주입)를 우회해 GCS로 직행하려 XMLHttpRequest 사용(avatar 동형).
function putToSignedUrl(
  uploadUrl: string,
  file: File,
  contentType: string,
  requiredHeaders: Record<string, string>,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', contentType);
    for (const [k, v] of Object.entries(requiredHeaders)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`PUT ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('PUT network error'));
    xhr.send(file);
  });
}

async function confirmUpload(
  objectPath: string,
  filename: string,
  contentType: string,
  projectId: string,
  folderId: string | null,
): Promise<Asset> {
  const res = await fetchWithAuth('/api/assets/upload-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object_path: objectPath,
      filename,
      content_type: contentType,
      project_id: projectId,
      folder_id: folderId,
    }),
  });
  if (!res.ok) throw new Error(`upload-confirm failed: ${res.status}`);
  const json = (await res.json()) as { data: Asset };
  return json.data;
}

/**
 * upload-url → 서명 PUT(Content-Type + required_put_headers) → confirm. 신규 Asset을 반환한다.
 * project_id는 upload-url·confirm 양단에 «동일»하게 보내야 한다(confirm의 object_path prefix 검사).
 */
export async function uploadStorageAsset(params: {
  file: File;
  projectId: string;
  folderId: string | null;
  onProgress?: (pct: number) => void;
}): Promise<Asset> {
  const { file, projectId, folderId, onProgress } = params;
  // 빈 file.type이면 Content-Type↔서명 매칭이 깨진다 — upload-url·PUT·confirm 세 곳에 «동일» 문자열을
  // 보내도록 폴백을 여기서 한 번 확定.
  const contentType = file.type || 'application/octet-stream';
  const { upload_url, object_path, required_put_headers } = await requestUploadUrl(file.name, contentType, projectId);
  await putToSignedUrl(upload_url, file, contentType, required_put_headers, onProgress);
  return confirmUpload(object_path, file.name, contentType, projectId, folderId);
}
